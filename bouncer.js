const WebSocket = require("ws");
const { verifySignature, validateEvent, nip19 } = require("nostr-tools");
const auth = require("./auth.js");
const nip42 = require("./nip42.js");

let { relays, approved_publishers, log_about_relays, authorized_keys, private_keys, reconnect_time, wait_eose, pause_on_limit, eose_timeout, max_eose_score, cache_relays, max_orphan_sess } = require("./config");

const socks = new Set();
const csess = new Map();

log_about_relays = process.env.LOG_ABOUT_RELAYS || log_about_relays;
authorized_keys = authorized_keys?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
approved_publishers = approved_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);

// CL MaxEoseScore: Set <max_eose_score> as 0 if configured relays is under of the expected number from <max_eose_score>
if (relays.length < max_eose_score) max_eose_score = 0;

cache_relays = cache_relays?.map(i => i.endsWith("/") ? i : i + "/");

// CL - User socket
module.exports = (ws, req) => {
  let authKey = null;
  let authorized = true;
  let orphan = getOrphanSess(); // if available

  ws.id = orphan || (process.pid + Math.floor(Math.random() * 1000) + "_" + csess.size);
  ws.subs = new Map(); // contains filter submitted by clients. per subID
  ws.pause_subs = new Set(); // pause subscriptions from receiving events after reached over <filter.limit> until all relays send EOSE. per subID
  ws.events = new Map(); // only to prevent the retransmit of the same event. per subID
  ws.my_events = new Set(); // for event retransmitting.
  ws.pendingEOSE = new Map(); // each contain subID
  ws.EOSETimeout = new Map(); // per subID
  ws.reconnectTimeout = new Set(); // relays timeout() before reconnection. Only use after client disconnected.

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

  console.log(process.pid, `->- ${req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address} connected as ${ws.id} ${orphan ? "(orphan reused)" : ""}`);
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
        if (!validateEvent(data[1]) || !verifySignature(data[1])) return ws.send(JSON.stringify(["NOTICE", "error: invalid event"]));
        if (data[1].kind == 22242) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: kind 22242"]));

        if (
          approved_publishers?.length &&
          !approved_publishers?.includes(data[1].pubkey)
        ) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: unauthorized"]));

        ws.my_events.add(data[1]);
        direct_bc(data, ws.id);
        cache_bc(data, ws.id);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ":
        if (!authorized) return;
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: expected subID a string. but got the otherwise."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["CLOSED", data[1], "error: expected filter to be obj, instead gives the otherwise."]));
        if (ws.subs.has(data[1])) return ws.send(JSON.stringify(["CLOSED", data[1], "duplicate: this sub is already opened."]));
        ws.subs.set(data[1], data.slice(2));
        ws.events.set(data[1], new Set());
        ws.pause_subs.delete(data[1]);
        bc(data, ws.id);
        if (data[2]?.limit < 1) return ws.send(JSON.stringify(["EOSE", data[1]]));
        ws.pendingEOSE.set(data[1], 0);
        break;
      case "CLOSE":
        if (!authorized) return;
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (!ws.subs.has(data[1])) return ws.send(JSON.stringify(["CLOSED", data[1], "error: this sub is not opened."]));
        ws.subs.delete(data[1]);
        ws.events.delete(data[1]);
        ws.pendingEOSE.delete(data[1]);
        ws.pause_subs.delete(data[1]);
        cancel_EOSETimeout(ws.id, data[1]);

        cache_bc(data, ws.id);
        direct_bc(data, ws.id);
        ws.send(JSON.stringify(["CLOSED", data[1], ""]));
        break;
      case "AUTH":
        if (auth(authKey, data[1], ws, req)) {
          ws.pubkey = data[1].pubkey;
          console.log(process.pid, "---", ws.id, "successfully authorized as", ws.pubkey, private_keys[ws.pubkey] ? "(admin)" : "(user)");
          if (authorized) return;
          csess.set(ws.id, ws);
          updateSess(ws.id);
          if (!orphan) newsess(ws.id);
          authorized = true;
        }
        break;
      default:
        ws.send(JSON.stringify(["NOTICE", "error: unrecognized command."]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    console.log(process.pid, "---", "Sock", ws.id, "has disconnected.", `(${howManyOrphanSess()+1} orphans)`);
    if (csess.has(ws.id)) csess.set(ws.id, null); // set as orphan.

    for (i of ws.EOSETimeout) {
      clearTimeout(i[1]);
    }

    if (!authorized) return;

    for (i of ws.reconnectTimeout) {
      clearTimeout(i);
      // Let the garbage collector do the thing. No need to add ws.reconnectTimeout.delete(i);
    }

    for (i of ws.subs) {
      direct_bc(["CLOSE", i[0]], ws.id);
      cache_bc(["CLOSE", i[0]], ws.id);
    }

    onClientDisconnect();

    // admin session must be destroyed quick.
    if (ws.pubkey) terminate_sess(ws.id);
  });

  if (authorized) {
    csess.set(ws.id, ws);
    updateSess(ws.id);
    if (!orphan) newsess(ws.id);
  }
}

// CL - Set up EOSE timeout
function timeoutEOSE(id, subid) {
  const c = csess.get(id);
  if (!c) return;

  clearTimeout(c.EOSETimeout.get(subid));
  c.EOSETimeout.set(subid, setTimeout(_ => timed_out_eose(id, subid), eose_timeout || 2300));
}

// CL - Handle timed out EOSE
function timed_out_eose(id, subid) {
  const c = csess.get(id);
  if (!c) return;
  c.EOSETimeout.delete(subid);
  if (!c.pendingEOSE.has(subid)) return;

  c.pendingEOSE.delete(subid);
  if (c.pause_subs.has(subid)) return c.pause_subs.delete(subid);
  c.send(JSON.stringify(["EOSE", subid]));
}

function cancel_EOSETimeout(id, subid) {
  const c = csess.get(id);
  if (!c) return;
  clearTimeout(c.EOSETimeout.get(subid));
  c.EOSETimeout.delete(subid);
}

// WS - New session for client $id
function newsess(id) {
  cache_relays?.forEach(_ => newConn(_, id));
  relays.forEach(_ => newConn(_, id));
}

// WS - Broadcast message to every existing sockets
function direct_bc(msg, id) {
  for (sock of socks) {
    if (cache_relays?.includes(sock.url)) continue;
    if (sock.id !== id) continue;
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.send(JSON.stringify(msg));
  }
}

function cache_bc(msg, id) {
  for (sock of socks) {
    if (!cache_relays?.includes(sock.url)) continue;
    if (sock.id !== id) continue;
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.send(JSON.stringify(msg));
  }
}

function bc(msg, id) {
  if (!cache_relays?.length) direct_bc(msg, id);
  else cache_bc(msg, id);
}

// WS - Terminate all existing sockets that were for <id>
function terminate_sess(id) {
  csess.delete(id);
  for (sock of socks) {
    if (sock.id !== id) continue;
    sock.terminate();
    socks.delete(sock);
  }
}

function onClientDisconnect() {
  const orphanSessNum = howManyOrphanSess();
  const max = max_orphan_sess || 0;
  if (orphanSessNum > max) {
    console.log(process.pid, `There are ${orphanSessNum} orphan sessions. I will clear ${orphanSessNum - max} of orphan sessions.`);
    clearOrphanSess(orphanSessNum - max);
  }
}

function getOrphanSess() {
  for (sess of csess) {
    if (sess[1] !== null) continue;
    return sess[0];
    break;
  }
}

function howManyOrphanSess() {
  let howMany = 0;
  for (sess of csess) {
    if (sess[1] !== null) continue;
    howMany++
  }

  return howMany;
}

function clearOrphanSess(l) {
  let cn = 0;
  for (sess of csess) {
    if (cn >= l) break;
    if (sess[1] !== null) continue;
    terminate_sess(sess[0]);
    cn++;
  }
}

function updateSess(id) {
  for (sock of socks) {
    if (sock.id !== id) continue;
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.client = csess.get(id);
  }
}

// WS - Sessions
function newConn(addr, id) {
  if (!csess.has(id)) return;
  const relay = new WebSocket(addr, {
    headers: {
      "User-Agent": "Bostr; The nostr relay bouncer; https://github.com/Yonle/bostr"
    }
  });

  relay.id = id;
  relay.client = csess.get(id);
  relay.on('open', _ => {
    if (!csess.has(id)) return relay.terminate();
    socks.add(relay); // Add this socket session to [socks]
    if (log_about_relays) console.log(process.pid, "---", `[${id}] [${socks.size}/${relays.length*csess.size}] ${relay.url} is connected ${!relay.client ? "(orphan)" : ""}`);

    if (!relay.client) return; // is orphan, do nothing.
    for (i of relay.client.my_events) {
      relay.send(JSON.stringify(["EVENT", i]));
    }

    for (i of relay.client.subs) {
      relay.send(JSON.stringify(["REQ", i[0], ...i[1]]));
    }
  });

  relay.on('message', data => {
    if (!relay.client) return;
    try {
      data = JSON.parse(data);
    } catch (error) {
      return;
    }

    switch (data[0]) {
      case "EVENT": {
        if (data.length < 3 || typeof(data[1]) !== "string" || typeof(data[2]) !== "object") return;
        if (!relay.client.subs.has(data[1])) return;
        timeoutEOSE(id, data[1]);
        if (relay.client.pause_subs.has(data[1]) && !cache_relays?.includes(relay.url)) return;

        // if filter.since > receivedEvent.created_at, skip
        // if receivedEvent.created_at > filter.until, skip
        const cFilter = relay.client.subs.get(data[1])
        if (cFilter?.since > data[2].created_at) return;
        if (data[2].created_at > cFilter?.until) return;
        const NotInSearchQuery = "search" in cFilter && !data[2]?.content?.toLowerCase().includes(cFilter.search.toLowerCase());

        if (NotInSearchQuery) return;
        if (relay.client.events.get(data[1]).has(data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        if (!relay.client.pause_subs.has(data[1])) {
          relay.client.events.get(data[1]).add(data[2]?.id);
          relay.client.send(JSON.stringify(data));
        }

        // send into cache relays.
        if (!cache_relays?.includes(relay.url)) cache_bc(["EVENT", data[2]], id);

        // Now count for REQ limit requested by client.
        // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

        // Skip if EOSE has been omitted
        if (!relay.client.pendingEOSE.has(data[1]) || !relay.client.subs.get(data[1])?.limit || relay.client.pause_subs.has(data[1])) return;
        if (relay.client.events.get(data[1]).size >= relay.client.subs.get(data[1])?.limit) {
          // Once reached to <filter.limit>, send EOSE to client.
          relay.client.send(JSON.stringify(["EOSE", data[1]]));
          if (pause_on_limit || cache_relays?.includes(relay.url)) {
            relay.client.pause_subs.add(data[1]);
          } else {
            relay.client.pendingEOSE.delete(data[1]);
          }
        }
        break;
      }
      case "EOSE":
        if (!relay.client.pendingEOSE.has(data[1])) return;
        relay.client.pendingEOSE.set(data[1], relay.client.pendingEOSE.get(data[1]) + 1);
        if (log_about_relays) console.log(process.pid, "---", `[${id}]`, `got EOSE from ${relay.url} for ${data[1]}. There are ${relay.client.pendingEOSE.get(data[1])} EOSE received out of ${Array.from(socks).filter(sock => sock.id === id).length} connected relays.`);

        if (!cache_relays?.includes(relay.url)) {
          if (wait_eose && ((relay.client.pendingEOSE.get(data[1]) < max_eose_score) || (relay.client.pendingEOSE.get(data[1]) < Array.from(socks).filter(sock => sock.id === id).length))) return;
          if (relay.client.pause_subs.has(data[1])) return relay.client.pause_subs.delete(data[1]);

          cancel_EOSETimeout(data[1]);
        } else {
          if (relay.client.pendingEOSE.get(data[1]) < Array.from(socks).filter(sock => (sock.id === id) && cache_relays?.includes(sock.url)).length) return;
          // get the filter
          const filter = relay.client.subs.get(data[1]);
          if (relay.client.pause_subs.has(data[1])) {
            relay.client.pause_subs.delete(data[1]);
            relay.client.pendingEOSE.delete(data[1]);
          }

          // now req to the direct connection, with the recent one please.
          return direct_bc(["REQ", data[1], filter], id);
        }

        relay.client.send(JSON.stringify(data));
        break;
      case "AUTH":
        if (!private_keys || typeof(data[1]) !== "string" || !relay.client.pubkey) return;
        nip42(relay, relay.client.pubkey, private_keys[relay.client.pubkey], data[1]);
        break;
    }
  });

  relay.on('error', _ => {
    if (log_about_relays) console.error(process.pid, "-!-", `[${id}]`, relay.url, _.toString())
  });

  relay.on('close', _ => {
    socks.delete(relay) // Remove this socket session from [socks] list
    if (log_about_relays) console.log(process.pid, "-!-", `[${id}] [${socks.size}/${relays.length*csess.size}]`, "Disconnected from", relay.url);

    if (!csess.has(id)) return;
    const reconnectTimeout = setTimeout(_ => {
      newConn(addr, id);
      relay.client?.reconnectTimeout.delete(reconnectTimeout);
    }, reconnect_time || 5000); // As a bouncer server, We need to reconnect.
    relay.client?.reconnectTimeout.add(reconnectTimeout);
  });
}
