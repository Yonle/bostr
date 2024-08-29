"use strict";
// Anything about talking to upstream relays is handled here.

const { parentPort, threadId } = require("node:worker_threads");
const { version } = require("./package.json");
const WebSocket = require("ws");
const { validateEvent, nip19, matchFilters, mergeFilters, getFilterLimit } = require("nostr-tools");
const nip42 = require("./nip42.js");

let { relays, log_about_relays, server_meta, private_keys, reconnect_time, wait_eose, pause_on_limit, max_eose_score, upstream_ratelimit_expiration, max_client_subs, idle_sessions, cache_relays, loadbalancer, max_known_events } = require(process.env.BOSTR_CONFIG_PATH || "./config");

log_about_relays = process.env.LOG_ABOUT_RELAYS || log_about_relays;
loadbalancer = loadbalancer || [];
if (relays.length) loadbalancer.unshift(undefined);

for (const key in private_keys) {
  if (!key.startsWith("npub")) continue;
  private_keys[nip19.decode(key).data] = private_keys[key];

  delete private_keys[key];
}

// CL MaxEoseScore: Set <max_eose_score> as 0 if configured relays is under of the expected number from <max_eose_score>
if (relays.length < max_eose_score) max_eose_score = 0;

const csess = {};
const userRelays = {}; // per ID contains Set() of <WebSocket>
const idleSess = new Set();
const idents = {};

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
      getIdleSess(m.data);
      break;
    case "req": {
      if (!csess.hasOwnProperty(m.id)) return;
      const ws = csess[m.id];

      if ((max_client_subs !== -1) && (Object.keys(ws.subs).length >= max_client_subs))
        return parentPort.postMessage({
          type: "upstream_msg",
          id: m.id,
          data: JSON.stringify(["CLOSED", m.sid, "rate-limited: too many subscriptions."])
        });
      const origID = m.sid;
      if (ws.fakesubalias.hasOwnProperty(origID)) {
        const faked = ws.fakesubalias[origID];
        delete ws.subs[origID];
        delete ws.events[origID];
        delete ws.pendingEOSE[origID];
        ws.pause_subs.delete(origID);
        delete ws.fakesubalias[origID];
        delete ws.subalias[faked];
        delete ws.mergedFilters[origID];
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

      if (max_known_events && getFilterLimit(filter) > max_known_events)
        filter.limit = max_known_events;

      ws.subs[origID] = filters;
      ws.events[origID] = new Set();
      ws.pause_subs.delete(origID);
      ws.subalias[faked] = origID;
      ws.fakesubalias[origID] = faked;
      if (!filter.since) filter.since = Math.floor(Date.now() / 1000); // Will not impact everything. Only used for handling passing pause_on_limit (or save mode)
      ws.mergedFilters[origID] = filter;
      bc(["REQ", faked, ...filters], m.id);
      if (filter.limit < 1) return parentPort.postMessage({
        type: "upstream_msg",
        id: m.id,
        data: JSON.stringify(["EOSE", origID])
      });
      ws.pendingEOSE[origID] = 0;
      break;
    }
    case "close": {
      if (!csess.hasOwnProperty(m.id)) return;
      const ws = csess[m.id];
      if (!ws.fakesubalias.hasOwnProperty(m.sid)) return;

      const origID = m.sid;
      const faked = ws.fakesubalias[origID];
      delete ws.subs[origID];
      delete ws.events[origID];
      delete ws.pendingEOSE[origID];
      ws.pause_subs.delete(origID);
      delete ws.fakesubalias[origID];
      delete ws.subalias[faked];
      delete ws.mergedFilters[origID];

      bc(["CLOSE", faked], m.id);
      parentPort.postMessage({
        type: "upstream_msg",
        id: m.id,
        data: JSON.stringify(["CLOSED", origID, ""])
      });
      break;
    }
    case "event": {
      if (!csess.hasOwnProperty(m.id)) return;
      const ws = csess[m.id];

      bc(["EVENT", m.event], m.id);
      parentPort.postMessage({
        type: "upstream_msg",
        id: m.id,
        data: JSON.stringify(["OK", m.event.id, true, ""])
      });
      break;
    }
    case "destroy":
      if (!csess.hasOwnProperty(m.id)) return;

      for (const sock of userRelays[m.id]) {
        sock.terminate();
      }

      delete userRelays[m.id];
      delete csess[m.id];
      delete idents[m.ident];
      break;
    case "auth":
      if (!csess.hasOwnProperty(m.id)) return;
      if (csess[m.id].pubkey === m.pubkey) return;
      csess[m.id].pubkey = m.pubkey;
      if (m.pubkey && private_keys[m.pubkey]) {
        for (const relay of userRelays[m.id]) {
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

  userRelays[id] = new Set();
  csess[id] = null;
  idleSess.add(id);

  if (cache_relays) {
    for (const url of cache_relays) {
      if (!csess.hasOwnProperty(id)) break;
      const relay = new Session(url, id);
      userRelays[id].add(relay);
    }
  }

  switch (shift) {
    case undefined:
      for (const url of relays) {
        if (!csess.hasOwnProperty(id)) break;
        const relay = new Session(url, id);
        userRelays[id].add(relay);
      }
      break;
    default:
      if (!csess.hasOwnProperty(id)) break;
      const relay = new Session(shift, id);
      userRelays[id].add(relay);
      break;
  }
}

// WS - Broadcast message to every upstream relays
function bc(msg, id, toCacheOnly) {
  if (toCacheOnly && !cache_relays?.length) return;
  for (const relay of userRelays[id]) {
    if (relay.readyState !== 1) continue;
    if (toCacheOnly && !relay.isCache) continue;

    // skip the ratelimit after <config.upstream_ratelimit_expiration>
    if ((upstream_ratelimit_expiration) > (Date.now() - relay.ratelimit)) continue;

    relay.send(JSON.stringify(msg));
  }
}

function getIdleSess(ws) {
  if (idents.hasOwnProperty(ws.ident)) {
    return parentPort.postMessage({
      type: "sessreg",
      ident: ws.ident,
      id: idents[ws.ident].id
    });
  }

  ws.subs = {}; // contains filter submitted by clients. per subID
  ws.pause_subs = new Set(); // pause subscriptions from receiving events after reached over <filter.limit> until all relays send EOSE. per subID
  ws.events = {}; // only to prevent the retransmit of the same event. per subID
  ws.pendingEOSE = {}; // each contain subID of integer
  ws.reconnectTimeout = new Set(); // relay's timeout() before reconnection. Only use after client disconnected.
  ws.subalias = {};
  ws.fakesubalias = {};
  ws.mergedFilters = {};
  ws.id = idleSess.values().next().value;

  if (ws.pubkey && private_keys[ws.pubkey]) {
    for (const relay of userRelays[ws.id]) {
      for (const challenge of relay.pendingNIP42) {
        nip42(relay, ws.pubkey, private_keys[ws.pubkey], challenge);
        relay.pendingNIP42.delete(challenge);
      }
    }
  }

  idleSess.delete(ws.id);
  csess[ws.id] = ws;
  idents[ws.ident] = ws;

  parentPort.postMessage({
    type: "sessreg",
    ident: ws.ident,
    id: ws.id
  });

  console.log(threadId, "---", ws.ip, "is now using session", ws.id);

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

class Session extends WebSocket {
  constructor(addr, id, reconn_t = 0) {
    if (!stats[addr]) stats[addr] = { raw_rx: 0, rx: 0, tx: 0, f: 0 };
    super(addr, {
      headers: {
        "User-Agent": `Bostr ${version}; The nostr relay bouncer; https://codeberg.org/Yonle/bostr; ConnID: ${id}; ${server_meta.canonical_url || "No canonical bouncer URL specified"}; Contact: ${server_meta.contact}`,
      }
    });

    this.id = id;
    this.addr = addr;
    this.reconn_t = reconn_t;
    this.isCache = relay_type(addr) === "cache_relay";
    this.isLoadBalancer = relay_type(addr) === "loadbalancer";
    this.ratelimit = 0;
    this.pendingNIP42 = new Set();

    this.on('open', receiverOnOpen);
    this.on('message', receiverOnMessage);
    this.on('error', receiverOnError);
    this.on('close', receiverOnClose);
    this.on('unexpected-response', receiverOnUnexpectedResponse);
  }
}

function receiverOnOpen() {
  if (!csess.hasOwnProperty(this.id)) return this.terminate();
  const client = csess[this.id];
  this.reconn_t = 0;
  if (log_about_relays) console.log(threadId, "---", this.id, "Connected to", this.addr, `(${relay_type(this.addr)})`);

  if (!client) return;

  for (const i in client.subs) {
    this.send(JSON.stringify(["REQ", client.fakesubalias[i], ...client.subs[i]]));
  }
}

function receiverOnMessage(data) {
  try {
    data = JSON.parse(data);
  } catch (error) {
    return;
  }
  const client = csess[this.id];
  if (!client) return;

  switch (data[0]) {
    case "EVENT": {
      stats._global.raw_rx++;
      stats[this.addr].raw_rx++;
      if (data.length < 3 || typeof(data[1]) !== "string" || typeof(data[2]) !== "object") return;
      if (!client.subalias.hasOwnProperty(data[1])) return;
      data[1] = client.subalias[data[1]];

      if (client.events[data[1]].has(data[2]?.id)) return; // No need to transmit once it has been transmitted before.
      if (!this.isCache) bc(["EVENT", data[2]], this.id, true); // store to cache relay
      const filter = client.mergedFilters[data[1]];
      if (client.pause_subs.has(data[1]) && (filter.since > data[2].created_at) && !this.isCache) return;

      if (client.rejectKinds && client.rejectKinds.includes(data[2]?.id)) return;

      const filters = client.subs[data[1]];
      if (!_matchFilters(filters, data[2])) return;

      const NotInSearchQuery = "search" in filter && !data[2]?.content?.toLowerCase().includes(filter.search.toLowerCase());
      if (NotInSearchQuery) return;

      if (!this.isLoadBalancer) client.events[data[1]].add(data[2]?.id);
      parentPort.postMessage({ type: "upstream_msg", id: this.id, data: JSON.stringify(data) });

      if (max_known_events && client.events[data[1]].size > max_known_events)
        client.events[data[1]].delete(client.events[data[1]].values().next().value);

      stats._global.rx++;
      stats[this.addr].rx++;

      // Now count for REQ limit requested by client.
      // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

      // Skip if EOSE has been omitted
      if (!client.pendingEOSE.hasOwnProperty(data[1]) || client.pause_subs.has(data[1]) || this.isLoadBalancer) return;
      const limit = getFilterLimit(filter);
      if (limit === Infinity) return;
      if (client.events[data[1]].size >= limit) {
        // Once reached to <filter.limit>, send EOSE to client.
        parentPort.postMessage({ type: "upstream_msg", id: this.id, data: JSON.stringify(["EOSE", data[1]]) });

        if (!client.accurateMode && (client.saveMode || pause_on_limit)) {
          client.pause_subs.add(data[1]);
        } else {
          delete client.pendingEOSE[data[1]];
        }
      }
      break;
    }
    case "EOSE":
      if (!client.subalias.hasOwnProperty(data[1])) return;
      data[1] = client.subalias[data[1]];
      if (!client.pendingEOSE.hasOwnProperty(data[1]) && !this.isLoadBalancer) return;
      client.pendingEOSE[data[1]]++;

      if (log_about_relays) console.log(threadId, "---", this.id, `got EOSE from ${this.addr} for ${data[1]}. There are ${client.pendingEOSE[data[1]]} EOSE received out of ${userRelays[this.id].size} connected relays.`);

      if (!this.isCache && (wait_eose && ((client.pendingEOSE[data[1]] < max_eose_score) || (client.pendingEOSE[data[1]] < userRelays[this.id].size)))) return;
      if (this.isCache && !client.events[data[1]].size) return; // if cache relays did not send anything but EOSE, Don't send EOSE yet.
      delete client.pendingEOSE[data[1]];

      if (client.pause_subs.has(data[1]) && !this.isLoadBalancer) {
        client.pause_subs.delete(data[1]);
      } else {
        parentPort.postMessage({ type: "upstream_msg", id: this.id, data: JSON.stringify(data) });
      }
      break;
    case "AUTH":
      if (!private_keys || typeof(data[1]) !== "string" || !client.pubkey) return this.pendingNIP42.add(data[1]);
      nip42(this, client.pubkey, private_keys[client.pubkey], data[1]);
      break;

    case "NOTICE":
      if (typeof(data[1]) !== "string") return;
      if (data[1].startsWith("rate-limited")) this.ratelimit = Date.now();

      if (log_about_relays) console.log(threadId, this.id, this.addr, data[0], data[1]);

      stats._global.f++
      stats[this.addr].f++

      break;

    case "CLOSED":
      if ((typeof(data[1]) !== "string") || (typeof(data[2]) !== "string")) return;
      if (data[2].startsWith("rate-limited")) this.ratelimit = Date.now();

      if (log_about_relays) console.log(threadId, this.id, this.addr, data[0], data[1], data[2]);

      if (data[2].length) {
        stats._global.f++;
        stats[this.addr].f++;
      }
      if (client.pendingEOSE.hasOwnProperty(data[1])) client.pendingEOSE[data[1]]++;
      break;

    case "OK":
      if ((typeof(data[1]) !== "string") || (typeof(data[2]) !== "boolean") || (typeof(data[3]) !== "string")) return;
      if (data[3].startsWith("rate-limited")) this.ratelimit = Date.now();

      if (log_about_relays) console.log(threadId, this.id, this.addr, data[0], data[1], data[2], data[3]);

      switch (data[2]) {
        case true:
          stats._global.tx++;
          stats[this.addr].tx++;
        case false:
          stats._global.f++
          stats[this.addr].f++
      }
      break;
  }
}

function receiverOnError(_) {
  console.error(threadId, "-!-", this.id, this.addr, _.toString());
}

function receiverOnClose() {
  if (!userRelays.hasOwnProperty(this.id)) return;
  userRelays[this.id].delete(this);
  if (log_about_relays) console.log(threadId, "-!-", this.id, "Disconnected from", this.addr, `(${relay_type(this.addr)})`);

  this.reconn_t += reconnect_time || 5000;
  setTimeout(_ => {
    if (!csess.hasOwnProperty(this.id)) return;
    const relay = new Session(this.addr, this.id, this.reconn_t);
    userRelays[this.id].add(relay);
  }, this.reconn_t);

  stats._global.f++
  stats[this.addr].f++
}

function receiverOnUnexpectedResponse(req, res) {
  if (!userRelays.hasOwnProperty(this.id)) return;
  userRelays[this.id].delete(this);
  if (res.statusCode >= 500) return this.emit("close", null);
  relays.splice(relays.indexOf(this.addr), 1);
  cache_relays.splice(cache_relays.indexOf(this.addr), 1);
  loadbalancer.splice(loadbalancer.indexOf(this.addr), 1);
  console.log(threadId, "-!-", `${this.addr} give status code ${res.statusCode}. Not (re)connect with new session again.`);

  stats._global.f++
  stats[this.addr].f++
}

for (let i = 1; i <= (idle_sessions || 1); i++) {
  newsess();
}
