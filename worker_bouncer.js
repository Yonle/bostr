"use strict";
// Anything about talking to upstream relays is handled here.

const { parentPort, threadId } = require("worker_threads");
const { version } = require("./package.json");
const WebSocket = require("ws");
const { validateEvent, nip19, matchFilters, mergeFilters, getFilterLimit } = require("nostr-tools");
const nip42 = require("./nip42.js");

let { relays, allowed_publishers, approved_publishers, blocked_publishers, log_about_relays, authorized_keys, private_keys, reconnect_time, wait_eose, pause_on_limit, max_eose_score, broadcast_ratelimit, upstream_ratelimit_expiration, max_client_subs, idle_sessions, cache_relays, noscraper, loadbalancer } = require(process.env.BOSTR_CONFIG_PATH || "./config");

log_about_relays = process.env.LOG_ABOUT_RELAYS || log_about_relays;

loadbalancer = loadbalancer || [];
if (relays.length) loadbalancer.unshift("_me");

// CL MaxEoseScore: Set <max_eose_score> as 0 if configured relays is under of the expected number from <max_eose_score>
if (relays.length < max_eose_score) max_eose_score = 0;

const csess = new Map(); // this is used for relays.
const userRelays = new Map(); // per ID contains Set() of <WebSocket>
const idleSess = new Set();

let stats = {
  _global: {
    raw_rx: 0,
    rx: 0,
    tx: 0,
    f: 0
  }
};

parentPort.on('message', m => {
  switch (m.type) {
    case "getsess":
      // [<ident>, <user info>]
      getIdleSess(m.ident, m.data);
      break;
    case "req": {
      if (!csess.has(m.id)) return;
      const ws = csess.get(m.id);

      if ((max_client_subs !== -1) && (ws.subs.size > max_client_subs))
        return parentPort.postMessage({
          type: "upstream_msg",
          id: m.id,
          data: JSON.stringify(["CLOSED", data[1], "rate-limited: too many subscriptions."])
        });
      const origID = m.sid;
      if (ws.fakesubalias.has(origID)) {
        const faked = ws.fakesubalias.get(origID);
        ws.subs.delete(origID);
        ws.events.delete(origID);
        ws.pendingEOSE.delete(origID);
        ws.pause_subs.delete(origID);
        ws.fakesubalias.delete(origID);
        ws.subalias.delete(faked);
        ws.mergedFilters.delete(origID);
        bc(["CLOSE", faked], m.id);
      };

      const faked = Date.now() + Math.random().toString(36);
      let filters = m.filters;
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

      ws.subs.set(origID, filters);
      ws.events.set(origID, new Set());
      ws.pause_subs.delete(origID);
      ws.subalias.set(faked, origID);
      ws.fakesubalias.set(origID, faked);
      if (!filter.since) filter.since = Math.floor(Date.now() / 1000); // Will not impact everything. Only used for handling passing pause_on_limit (or save mode)
      ws.mergedFilters.set(origID, filter);
      bc(["REQ", faked, ...filters], m.id);
      if (filter.limit < 1) return parentPort.postMessage({
        type: "upstream_msg",
        id: m.id,
        data: JSON.stringify(["EOSE", origID])
      });
      ws.pendingEOSE.set(origID, 0);
      break;
    }
    case "close": {
      if (!csess.has(m.id)) return;
      const ws = csess.get(m.id);
      if (!ws.fakesubalias.has(m.sid)) return;

      const origID = m.sid;
      const faked = ws.fakesubalias.get(origID);
      ws.subs.delete(origID);
      ws.events.delete(origID);
      ws.pendingEOSE.delete(origID);
      ws.pause_subs.delete(origID);
      ws.fakesubalias.delete(origID);
      ws.subalias.delete(faked);
      ws.mergedFilters.delete(origID);

      bc(["CLOSE", faked], m.id);
      parentPort.postMessage({
        type: "upstream_msg",
        id: m.id,
        data: JSON.stringify(["CLOSED", origID, ""])
      });
      break;
    }
    case "event": {
      if (!csess.has(m.id)) return;
      const ws = csess.get(m.id);

      ws.my_events.add(m.event.id);

      bc(["EVENT", m.event], m.id);
      parentPort.postMessage({
        type: "upstream_msg",
        id: m.id,
        data: JSON.stringify(["OK", m.event.id, true, ""])
      });
      break;
    }
    case "destroy":
      if (!csess.has(m.id)) return;

      for (const sock of userRelays.get(m.id)) {
        sock.terminate();
      }

      userRelays.delete(m.id);
      csess.delete(m.id);
      break;
    case "auth":
      if (!csess.has(m.id)) return;
      csess.get(m.id).pubkey = m.pubkey;
      if (m.pubkey && private_keys[m.pubkey]) {
        for (const relay of userRelays.get(m.id)) {
          for (const challenge of relay.pendingNIP42) {
            nip42(relay, m.pubkey, private_keys[m.pubkey], challenge);
            relay.pendingNIP42.delete(challenge);
          }
        }
      }

      break;
  }

  parentPort.postMessage({
    type: "stats",
    data: stats
  });
});

// WS - New session for client $id
// mostly for new idle session.
function newsess() {
  const id = Date.now() + "_" + threadId + "_" + Math.random();
  const shift = loadbalancer.shift();
  loadbalancer.push(shift);

  userRelays.set(id, new Set());
  csess.set(id, null);
  idleSess.add(id);

  if (cache_relays) {
    for (const url of cache_relays) {
      newConn(url, id);
    }
  }

  switch (shift) {
    case "_me":
      for (const url of relays) {
        newConn(url, id);
      }
      break;
    default:
      newConn(shift, id);
      break;
  }
}

// WS - Broadcast message to every existing sockets
function bc(msg, id, toCacheOnly) {
  if (toCacheOnly && !cache_relays?.length) return;
  for (const relay of userRelays.get(id)) {
    if (relay.readyState !== 1) continue;
    if (toCacheOnly && !relay.isCache) continue;

    // skip the ratelimit after <config.upstream_ratelimit_expiration>
    if ((upstream_ratelimit_expiration) > (Date.now() - relay.ratelimit)) continue;

    relay.send(JSON.stringify(msg));
  }
}

function getIdleSess(ident, infos) {
  const ws = {};
  ws.subs = new Map(); // contains filter submitted by clients. per subID
  ws.pause_subs = new Set(); // pause subscriptions from receiving events after reached over <filter.limit> until all relays send EOSE. per subID
  ws.events = new Map(); // only to prevent the retransmit of the same event. per subID
  ws.my_events = new Set(); // for event retransmitting.
  ws.pendingEOSE = new Map(); // each contain subID
  ws.reconnectTimeout = new Set(); // relays timeout() before reconnection. Only use after client disconnected.
  ws.subalias = new Map();
  ws.fakesubalias = new Map();
  ws.mergedFilters = new Map();

  // handled in bouncer.js
  ws.ip = null;
  ws.pubkey = null;
  ws.rejectKinds = null;
  ws.acceptKinds = null;
  ws.forcedLimit = null;
  ws.accurateMode = 0;
  ws.saveMode = 0;

  for (const i in infos) {
    ws[i] = infos[i];
  }

  if (ws.pubkey && private_keys[ws.pubkey]) {
    for (const relay of userRelays.get(ws.id)) {
      for (const challenge of relay.pendingNIP42) {
        nip42(relay, ws.pubkey, private_keys[ws.pubkey], challenge);
        relay.pendingNIP42.delete(challenge);
      }
    }
  }

  ws.id = idleSess.values().next().value;
  idleSess.delete(ws.id);
  csess.set(ws.id, ws);

  parentPort.postMessage({
    type: "sessreg",
    ident,
    id: ws.id
  });

  if (log_about_relays) console.log(threadId, "---", ws.ip, "is now using session", ws.id);

  newsess();
}

function _matchFilters(filters, event) {
  // nostr-tools being randomly throw error in their own code. Put safety.
  try {
    return matchFilters(filters, event);
  } catch {
    return false;
  }
}

function relay_type(addr) {
  switch (true) {
    case relays.includes(addr):
      return "relay";
      break;
    case cache_relays.includes(addr):
      return "cache_relay";
      break;
    case loadbalancer.includes(addr):
      return "loadbalancer";
      break;
  }
}

// WS - Sessions
function newConn(addr, id, reconn_t = 0) {
  if (!csess.has(id)) return;
  if (!stats[addr]) stats[addr] = { raw_rx: 0, rx: 0, tx: 0, f: 0 };
  const relay = new WebSocket(addr, {
    headers: {
      "User-Agent": `Bostr ${version}; The nostr relay bouncer; https://github.com/Yonle/bostr`,
    },
    noDelay: true,
    allowSynchronousEvents: true
  });

  relay.isCache = relay_type(addr) === "cache_relay";
  relay.isLoadBalancer = relay_type(addr) === "loadbalancer";
  relay.ratelimit = 0;
  relay.pendingNIP42 = new Set();
  relay.on('open', _ => {
    if (!csess.has(id)) return relay.terminate();
    const client = csess.get(id);
    reconn_t = 0;
    if (log_about_relays) console.log(threadId, "---", id, "Connected to", addr, `(${relay_type(addr)})`);

    if (!client) return;
    for (const i of client.my_events) {
      relay.send(JSON.stringify(["EVENT", i]));
    }

    for (const i of client.subs) {
      relay.send(JSON.stringify(["REQ", client.fakesubalias.get(i[0]), ...i[1]]));
    }
  });

  relay.on('message', data => {
    if (!csess.has(id)) return relay.terminate();
    try {
      data = JSON.parse(data);
    } catch (error) {
      return;
    }
    const client = csess.get(id);
    if (!client) return;

    switch (data[0]) {
      case "EVENT": {
        stats._global.raw_rx++;
        stats[addr].raw_rx++;
        if (data.length < 3 || typeof(data[1]) !== "string" || typeof(data[2]) !== "object") return;
        if (!client.subalias.has(data[1])) return;
        data[1] = client.subalias.get(data[1]);

        if (client.events.get(data[1]).has(data[2]?.id)) return; // No need to transmit once it has been transmitted before.
        if (!relay.isCache) bc(["EVENT", data[2]], id, true); // store to cache relay
        const filter = client.mergedFilters.get(data[1]);
        if (client.pause_subs.has(data[1]) && (filter.since > data[2].created_at) && !relay.isCache) return;

        if (client.rejectKinds && client.rejectKinds.includes(data[2]?.id)) return;

        const filters = client.subs.get(data[1]);
        if (!_matchFilters(filters, data[2])) return;

        const NotInSearchQuery = "search" in filter && !data[2]?.content?.toLowerCase().includes(filter.search.toLowerCase());
        if (NotInSearchQuery) return;

        if (!relay.isLoadBalancer) client.events.get(data[1]).add(data[2]?.id);
        parentPort.postMessage({ type: "upstream_msg", id, data: JSON.stringify(data) });

        stats._global.rx++;
        stats[addr].rx++;

        // Now count for REQ limit requested by client.
        // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

        // Skip if EOSE has been omitted
        if (!client.pendingEOSE.has(data[1]) || client.pause_subs.has(data[1]) || relay.isLoadBalancer) return;
        const limit = getFilterLimit(filter);
        if (limit === Infinity) return;
        if (client.events.get(data[1]).size >= limit) {
          // Once reached to <filter.limit>, send EOSE to client.
          parentPort.postMessage({ type: "upstream_msg", id, data: JSON.stringify(["EOSE", data[1]]) });

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
        if (!client.pendingEOSE.has(data[1]) && !relay.isLoadBalancer) return;
        client.pendingEOSE.set(data[1], client.pendingEOSE.get(data[1]) + 1);

        if (log_about_relays) console.log(threadId, "---", id, `got EOSE from ${addr} for ${data[1]}. There are ${client.pendingEOSE.get(data[1])} EOSE received out of ${userRelays.get(id).size} connected relays.`);

        if (!relay.isCache && (wait_eose && ((client.pendingEOSE.get(data[1]) < max_eose_score) || (client.pendingEOSE.get(data[1]) < userRelays.get(id).size)))) return;
        if (relay.isCache && !client.events.get(data[1]).size) return; // if cache relays did not send anything but EOSE, Don't send EOSE yet.
        client.pendingEOSE.delete(data[1]);

        if (client.pause_subs.has(data[1]) && !relay.isLoadBalancer) {
          client.pause_subs.delete(data[1]);
        } else {
          parentPort.postMessage({ type: "upstream_msg", id, data: JSON.stringify(data) });
        }
        break;
      case "AUTH":
        if (!private_keys || typeof(data[1]) !== "string" || !client.pubkey) return relay.pendingNIP42.add(data[1]);
        nip42(relay, client.pubkey, private_keys[client.pubkey], data[1]);
        break;

      case "NOTICE":
        if (typeof(data[1]) !== "string") return;
        if (data[1].startsWith("rate-limited")) relay.ratelimit = Date.now();

        if (log_about_relays) console.log(threadId, id, addr, data[0], data[1]);

        stats._global.f++
        stats[addr].f++

        break;

      case "CLOSED":
        if ((typeof(data[1]) !== "string") || (typeof(data[2]) !== "string")) return;
        if (data[2].startsWith("rate-limited")) relay.ratelimit = Date.now();

        if (log_about_relays) console.log(threadId, id, addr, data[0], data[1], data[2]);

        if (data[2].length) {
          stats._global.f++;
          stats[addr].f++;
        }
        if (client.pendingEOSE.has(data[1])) client.pendingEOSE.set(data[1], client.pendingEOSE.get(data[1]) + 1);
        break;

      case "OK":
        if ((typeof(data[1]) !== "string") || (typeof(data[2]) !== "boolean") || (typeof(data[3]) !== "string")) return;
        if (data[3].startsWith("rate-limited")) relay.ratelimit = Date.now();

        if (log_about_relays) console.log(threadId, id, addr, data[0], data[1], data[2], data[3]);

        switch (data[2]) {
          case true:
            stats._global.tx++;
            stats[addr].tx++;
          case false:
            stats._global.f++
            stats[addr].f++
        }

        break;
    }
  });

  relay.on('error', _ => {
    if (log_about_relays) console.error(threadId, "-!-", id, addr, _.toString())
  });

  relay.on('close', _ => {
    if (!userRelays.has(id)) return;
    userRelays.get(id).delete(relay); // Remove this socket session from <client.relays> list
    if (log_about_relays) console.log(threadId, "-!-", id, "Disconnected from", addr, `(${relay_type(addr)})`);
    reconn_t += reconnect_time || 5000
    setTimeout(_ => {
      newConn(addr, id, reconn_t);
    }, reconn_t);

    stats._global.f++
    stats[addr].f++
  });

  relay.on('unexpected-response', (req, res) => {
    if (!userRelays.has(id)) return;
    userRelays.get(id).delete(relay);
    if (res.statusCode >= 500) return relay.emit("close", null);
    relays = relays.filter(_ => _ != addr);
    console.log(threadId, "-!-", `${addr} give status code ${res.statusCode}. Not (re)connect with new session again.`);

    stats._global.f++
    stats[addr].f++
  });

  userRelays.get(id).add(relay); // Add this socket session to <client.relays>
}

for (let i = 1; i <= (idle_sessions || 1); i++) {
  newsess();
}