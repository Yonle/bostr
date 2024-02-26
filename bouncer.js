"use strict";
const { version } = require("./package.json");
const WebSocket = require("ws");
const querystring = require("querystring");
const { validateEvent, nip19, matchFilters, mergeFilters, getFilterLimit } = require("nostr-tools");
const auth = require("./auth.js");
const nip42 = require("./nip42.js");

let { relays, approved_publishers, log_about_relays, authorized_keys, private_keys, reconnect_time, wait_eose, pause_on_limit, max_eose_score, broadcast_ratelimit, upstream_ratelimit_expiration, max_client_subs } = require(process.env.BOSTR_CONFIG_PATH || "./config");

log_about_relays = process.env.LOG_ABOUT_RELAYS || log_about_relays;
authorized_keys = authorized_keys?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
approved_publishers = approved_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);

// CL MaxEoseScore: Set <max_eose_score> as 0 if configured relays is under of the expected number from <max_eose_score>
if (relays.length < max_eose_score) max_eose_score = 0;

// CL - User socket
module.exports = (ws, req, onClose) => {
  let query = querystring.parse(req.url.slice(2));
  let authKey = null;
  let authorized = true;
  let sessStarted = false;
  let lastEvent = Date.now();
  ws.ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address;
  ws.relays = new Set(); // Set() of connected relays.
  ws.subs = new Map(); // contains filter submitted by clients. per subID
  ws.pause_subs = new Set(); // pause subscriptions from receiving events after reached over <filter.limit> until all relays send EOSE. per subID
  ws.events = new Map(); // only to prevent the retransmit of the same event. per subID
  ws.my_events = new Set(); // for event retransmitting.
  ws.pendingEOSE = new Map(); // each contain subID
  ws.reconnectTimeout = new Set(); // relays timeout() before reconnection. Only use after client disconnected.
  ws.subalias = new Map();
  ws.fakesubalias = new Map();
  ws.mergedFilters = new Map();
  ws.pubkey = null;
  ws.rejectKinds = query.reject?.split(",").map(_ => parseInt(_));
  ws.acceptKinds = query.accept?.split(",").map(_ => parseInt(_));
  ws.forcedLimit = parseInt(query.limit);
  ws.accurateMode = parseInt(query.accurate);
  ws.saveMode = parseInt(query.save);

  if (authorized_keys?.length) {
    authKey = Date.now() + Math.random().toString(36);
    authorized = false;
    ws.send(JSON.stringify(["AUTH", authKey]));
  } else if (private_keys !== {}) {
    // If there is no whitelist, Then we ask to client what is their public key.
    // We will enable NIP-42 function for this session if user pubkey was available & valid in <private_keys>.

    // There is no need to limit this session. We only ask who is this user.
    // If it was the users listed at <private_keys> in config.js, Then the user could use NIP-42 protected relays.

    authKey = Date.now() + Math.random().toString(36);
    ws.send(JSON.stringify(["AUTH", authKey]));
  }

  console.log(process.pid, `->- ${ws.ip} connected [${req.headers["user-agent"] || ""}]`);
  ws.on("message", data => {
    try {
      data = JSON.parse(data);
    } catch {
      return ws.send(
        JSON.stringify(["NOTICE", "error: bad JSON."])
      )
    }

    switch (data[0]) {
      case "EVENT":
        if (!authorized) return;
        if (!validateEvent(data[1])) return ws.send(JSON.stringify(["NOTICE", "error: invalid event"]));
        if (data[1].kind == 22242) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: kind 22242"]));

        if (
          approved_publishers?.length &&
          !approved_publishers?.includes(data[1].pubkey)
        ) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: unauthorized"]));

        if (broadcast_ratelimit && (broadcast_ratelimit > (Date.now() - lastEvent))) {
          lastEvent = Date.now();
          return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rate-limited: request too fast."]));
        }

        lastEvent = Date.now();
        ws.my_events.add(data[1]);

        if (!ws.relays.size && !sessStarted) {
          console.log(process.pid, `>>>`, `${ws.ip} executed ${data[0]} command for the first. Initializing session`);
          newsess(ws);
          sessStarted = true;
        }

        bc(data, ws);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ": {
        if (!authorized) return;
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: expected subID a string. but got the otherwise."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["CLOSED", data[1], "error: expected filter to be obj, instead gives the otherwise."]));
        if ((max_client_subs !== -1) && (ws.subs.size > max_client_subs)) return ws.send(JSON.stringify(["CLOSED", data[1], "rate-limited: too many subscriptions."]));
        if (ws.subs.has(data[1])) return ws.send(JSON.stringify(["CLOSED", data[1], "duplicate: subscription already opened"]));
        const origID = data[1];
        const faked = Date.now() + Math.random().toString(36);
        let filters = data.slice(2);
        let filter = mergeFilters(...filters);

        for (const fn in filters) {
          if (!Array.isArray(filters[fn].kinds)) {
            filters[fn].kinds = ws.acceptKinds;
            continue;
          } else {
            filters[fn].kinds = filters[fn].kinds?.filter(kind => {
              if (ws.rejectKinds && ws.rejectKinds.includes(kind)) return false;
              if (ws.acceptKinds && !ws.acceptKinds.includes(kind)) return false;
              return true;
            });
          }

          if (filters[fn].limit > ws.forcedLimit)
            filters[fn].limit = ws.forcedLimit;
        }

        if (!ws.relays.size && !sessStarted) {
          console.log(process.pid, `>>>`, `${ws.ip} executed ${data[0]} command for the first. Initializing session`);
          newsess(ws);
          sessStarted = true;
        }

        ws.subs.set(origID, filters);
        ws.events.set(origID, new Set());
        ws.pause_subs.delete(origID);
        ws.subalias.set(faked, origID);
        ws.fakesubalias.set(origID, faked);
        ws.mergedFilters.set(origID, filter);
        data[1] = faked;
        bc(data, ws);
        if (filter.limit < 1) return ws.send(JSON.stringify(["EOSE", origID]));
        ws.pendingEOSE.set(origID, 0);
        break;
      }
      case "CLOSE":
        if (!authorized) return;
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (!ws.fakesubalias.has(data[1])) return ws.send(JSON.stringify(["CLOSED", data[1], "error: this sub is not opened."]));
        const origID = data[1];
        const faked = ws.fakesubalias.get(origID);
        ws.subs.delete(origID);
        ws.events.delete(origID);
        ws.pendingEOSE.delete(origID);
        ws.pause_subs.delete(origID);
        ws.fakesubalias.delete(origID);
        ws.subalias.delete(faked);
        ws.mergedFilters.delete(origID);

        data[1] = faked;
        bc(data, ws);
        ws.send(JSON.stringify(["CLOSED", origID, ""]));
        break;
      case "AUTH":
        if (auth(authKey, data[1], ws, req)) {
          ws.pubkey = data[1].pubkey;
          console.log(process.pid, "---", ws.ip, "successfully authorized as", ws.pubkey, private_keys[ws.pubkey] ? "(admin)" : "(user)");
          if (authorized) return;
          authorized = true;
          lastEvent = Date.now();
        }
        break;
      default:
        ws.send(JSON.stringify(["NOTICE", `error: unrecognized command: ${data[0]}`]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    onClose();

    console.log(process.pid, "---", `${ws.ip} disconnected`);

    for (const i of ws.reconnectTimeout) {
      clearTimeout(i);
      // Let the garbage collector do the thing. No need to add ws.reconnectTimeout.delete(i);
    }

    for (const sock of ws.relays) {
      sock.terminate();
    }
  });
}

// WS - New session for client $id
function newsess(ws) {
  relays.forEach(_ => newConn(_, ws));
}

// WS - Broadcast message to every existing sockets
function bc(msg, ws) {
  for (const sock of ws.relays) {
    if (sock.readyState !== 1) continue;

    // skip the ratelimit after <config.upstream_ratelimit_expiration>
    if ((upstream_ratelimit_expiration) > (Date.now() - sock.ratelimit)) continue;
    sock.send(JSON.stringify(msg));
  }
}

// WS - Sessions
function newConn(addr, client, reconn_t = 0) {
  if (client.readyState !== 1) return;
  const relay = new WebSocket(addr, {
    headers: {
      "User-Agent": `Bostr ${version}; The nostr relay bouncer; https://github.com/Yonle/bostr`
    },
    noDelay: true,
    allowSynchronousEvents: true
  });

  relay.ratelimit = 0;
  relay.on('open', _ => {
    if (client.readyState !== 1) return relay.terminate();
    reconn_t = 0;
    if (log_about_relays) console.log(process.pid, "---", client.ip, `${relay.url} is connected`);

    for (const i of client.my_events) {
      relay.send(JSON.stringify(["EVENT", i]));
    }

    for (const i of client.subs) {
      relay.send(JSON.stringify(["REQ", client.fakesubalias.get(i[0]), ...i[1]]));
    }
  });

  relay.on('message', data => {
    if (client.readyState !== 1) return relay.terminate();
    try {
      data = JSON.parse(data);
    } catch (error) {
      return;
    }

    switch (data[0]) {
      case "EVENT": {
        if (data.length < 3 || typeof(data[1]) !== "string" || typeof(data[2]) !== "object") return;
        if (!client.subalias.has(data[1])) return;
        data[1] = client.subalias.get(data[1]);
        if (client.pause_subs.has(data[1])) return;

        if (client.rejectKinds && client.rejectKinds.includes(data[2]?.id)) return;

        const filters = client.subs.get(data[1]);
        if (!matchFilters(filters, data[2])) return;

        const filter = client.mergedFilters.get(data[1]);
        const NotInSearchQuery = "search" in filter && !data[2]?.content?.toLowerCase().includes(filter.search.toLowerCase());
        if (NotInSearchQuery) return;
        if (client.events.get(data[1]).has(data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        client.events.get(data[1]).add(data[2]?.id);
        client.send(JSON.stringify(data));

        // Now count for REQ limit requested by client.
        // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

        // Skip if EOSE has been omitted
        if (!client.pendingEOSE.has(data[1])) return;
        const limit = getFilterLimit(filter);
        if (limit === Infinity) return;
        if (client.events.get(data[1]).size >= limit) {
          // Once reached to <filter.limit>, send EOSE to client.
          client.send(JSON.stringify(["EOSE", data[1]]));
          if (!client.accurateMode && (client.saveMode || pause_on_limit)) {
            client.pause_subs.add(data[1]);
          } else {
            client.pendingEOSE.delete(data[1]);
          }
        }
        break;
      }
      case "EOSE":
        if (!client.subalias.has(data[1])) return;
        data[1] = client.subalias.get(data[1]);
        if (!client.pendingEOSE.has(data[1])) return;
        client.pendingEOSE.set(data[1], client.pendingEOSE.get(data[1]) + 1);
        if (log_about_relays) console.log(process.pid, "---", client.ip, `got EOSE from ${relay.url} for ${data[1]}. There are ${client.pendingEOSE.get(data[1])} EOSE received out of ${client.relays.size} connected relays.`);

        if (wait_eose && ((client.pendingEOSE.get(data[1]) < max_eose_score) || (client.pendingEOSE.get(data[1]) < client.relays.size))) return;
        client.pendingEOSE.delete(data[1]);

        if (client.pause_subs.has(data[1])) {
          client.pause_subs.delete(data[1]);
        } else {
          client.send(JSON.stringify(data));
        }
        break;
      case "AUTH":
        if (!private_keys || typeof(data[1]) !== "string" || !client.pubkey) return;
        nip42(relay, client.pubkey, private_keys[client.pubkey], data[1]);
        break;

      case "NOTICE":
        if (typeof(data[1]) !== "string") return;
        if (data[1].startsWith("rate-limited")) relay.ratelimit = Date.now();

        break;

      case "CLOSED":
      case "OK":
        if (typeof(data[2]) !== "string") return;
        if (data[2].startsWith("rate-limited")) relay.ratelimit = Date.now();

        break;
    }
  });

  relay.on('error', _ => {
    if (log_about_relays) console.error(process.pid, "-!-", client.ip, relay.url, _.toString())
  });

  relay.on('close', _ => {
    if (client.readyState !== 1) return;
    client.relays.delete(relay); // Remove this socket session from <client.relays> list
    if (log_about_relays) console.log(process.pid, "-!-", client.ip, "Disconnected from", relay.url);
    reconn_t += reconnect_time || 5000
    const reconnectTimeout = setTimeout(_ => {
      newConn(addr, client, reconn_t);
      client?.reconnectTimeout.delete(reconnectTimeout);
    }, reconn_t); // As a bouncer server, We need to reconnect.
    client?.reconnectTimeout.add(reconnectTimeout);
  });

  relay.on('unexpected-response', (req, res) => {
    if (client.readyState !== 1) return;
    client.relays.delete(relay);
    if (res.statusCode >= 500) return relay.emit("close", null);
    relays = relays.filter(_ => !relay.url.startsWith(_));
    console.log(process.pid, "-!-", `${relay.url} give status code ${res.statusCode}. Not (re)connect with new session again.`);
  });

  client.relays.add(relay); // Add this socket session to <client.relays>
}
