"use strict";
// Anything about handling client connections is in this code.

const { Worker } = require("worker_threads");
const { version } = require("./package.json");
const querystring = require("querystring");
const { validateEvent, nip19, matchFilters, mergeFilters, getFilterLimit } = require("nostr-tools");
const auth = require("./auth.js");

let { relays, allowed_publishers, approved_publishers, blocked_publishers, log_about_relays, authorized_keys, private_keys, reconnect_time, wait_eose, pause_on_limit, max_eose_score, broadcast_ratelimit, upstream_ratelimit_expiration, max_client_subs, idle_sessions, cache_relays, noscraper, loadbalancer } = require(process.env.BOSTR_CONFIG_PATH || "./config");

log_about_relays = process.env.LOG_ABOUT_RELAYS || log_about_relays;
authorized_keys = authorized_keys?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
allowed_publishers = allowed_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
blocked_publishers = blocked_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);

loadbalancer = loadbalancer || [];
if (relays.length) loadbalancer.unshift("_me");

// CL MaxEoseScore: Set <max_eose_score> as 0 if configured relays is under of the expected number from <max_eose_score>
if (relays.length < max_eose_score) max_eose_score = 0;

// The following warning will be removed in the next 2 stable release
if (approved_publishers?.length) {
  allowed_publishers = approved_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
  console.warn(process.pid, "[config]");
  console.warn(process.pid, "[config]", "!!! Attention !!!");
  console.warn(process.pid, "[config]", "approved_publishers is deprecated. rename as allowed_publishers");
  console.warn(process.pid, "[config]");
}

const worker = new Worker(__dirname + "/worker_bouncer.js", { name: "Bostr (worker)" });

const csess = {}; // this is used for relays.
const userRelays = new Map(); // per ID contains Set() of <WebSocket>
const ident = new Map();

let zeroStats = {
  raw_rx: 0,
  rx: 0,
  tx: 0,
  f: 0
}
let stats = {};

// CL - User socket
function handleConnection(ws, req, onClose) {
  let query = querystring.parse(req.url.slice(2));
  let authKey = null;
  let authorized = true;
  let sessStarted = false;
  let lastEvent = Date.now();
  ws.onready = null;
  ws.ident = Date.now() + Math.random().toString(36);
  ws.id = null;
  ws.ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address;
  ws.pubkey = null;
  ws.rejectKinds = query.reject?.split(",").map(_ => parseInt(_));
  ws.acceptKinds = query.accept?.split(",").map(_ => parseInt(_));
  ws.forcedLimit = parseInt(query.limit);
  ws.accurateMode = parseInt(query.accurate);
  ws.saveMode = parseInt(query.save);

  ident.set(ws.ident, ws);

  if (noscraper || authorized_keys?.length) {
    authKey = Date.now() + Math.random().toString(36);
    authorized = false;
    ws.send(JSON.stringify(["AUTH", authKey]));
  } else if (Object.keys(private_keys).length) {
    // If there is no whitelist, Then we ask to client what is their public key.
    // We will enable NIP-42 function for this session if user pubkey was available & valid in <private_keys>.

    // There is no need to limit this session. We only ask who is this user.
    // If it was the users listed at <private_keys> in config.js, Then the user could use NIP-42 protected relays.

    authKey = Date.now() + Math.random().toString(36);
    ws.send(JSON.stringify(["AUTH", authKey]));
  }

  console.log(process.pid, `->- ${ws.ip} connected [${req.headers["user-agent"] || ""}]`);
  ws.on("message", async (data) => {
    try {
      data = JSON.parse(data);
    } catch {
      return ws.send(
        JSON.stringify(["NOTICE", "error: bad JSON."])
      )
    }

    switch (data[0]) {
      case "EVENT":
        if (!validateEvent(data[1])) return ws.send(JSON.stringify(["NOTICE", "error: invalid event"]));
        if (data[1].kind == 22242) return ws.send(JSON.stringify(["OK", data[1].id, false, "rejected: kind 22242"]));
        if (blocked_publishers?.includes(data[1].pubkey)) return ws.send(JSON.stringify(["OK", data[1].id, false, "blocked: this event author is blacklisted."]));
        if (!authorized) {
          ws.send(JSON.stringify(["OK", data[1].id, false, "auth-required: authentication is required to perform this action."]));
          return ws.send(JSON.stringify(["AUTH", authKey]));
        }

        if (
          allowed_publishers?.length &&
          !allowed_publishers?.includes(data[1].pubkey)
        ) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: unauthorized"]));

        if (broadcast_ratelimit && (broadcast_ratelimit > (Date.now() - lastEvent))) {
          lastEvent = Date.now();
          return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rate-limited: request too fast."]));
        }

        lastEvent = Date.now();
        if (!sessStarted) {
          console.log(process.pid, `>>>`, `${ws.ip} executed ${data[0]} command for the first. Initializing session`);
          await getIdleSess(ws);
          sessStarted = true;
        }

        _event(ws.id, data[1]);
        break;
      case "REQ": {
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: expected subID a string. but got the otherwise."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["CLOSED", data[1], "error: expected filter to be obj, instead gives the otherwise."]));
        if (!authorized) {
          ws.send(JSON.stringify(["CLOSED", data[1], "auth-required: authentication is required to perform this action."]));
          return ws.send(JSON.stringify(["AUTH", authKey]));
        }

        if (!sessStarted) {
          console.log(process.pid, `>>>`, `${ws.ip} executed ${data[0]} command for the first. Initializing session`);
          await getIdleSess(ws);
          sessStarted = true;
        }

        _req(ws.id, data[1], data.slice(2));
        break;
      }
      case "CLOSE":
        if (!authorized) return;
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        _close(ws.id, data[1]);
        break;
      case "AUTH":
        if (auth(authKey, data[1], ws, req)) {
          authKey = Date.now() + Math.random().toString(36);
          ws.pubkey = data[1].pubkey;
          console.log(process.pid, "---", ws.ip, "successfully authorized as", ws.pubkey, private_keys[ws.pubkey] ? "(admin)" : "(user)");
          _auth(ws.id, ws.pubkey);
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

    ident.delete(ws.ident);

    console.log(process.pid, "---", `${ws.ip} disconnected`);

    if (!sessStarted) return;
    _destroy(ws.id);
    delete csess[ws.id];
  });
}

function handleWorker(msg) {
  switch (msg.type) {
    case "sessreg": {
      if (!ident.has(msg.ident)) return _destroy(msg.id);
      const ws = ident.get(msg.ident);
      ws.id = msg.id;
      ws.onready();
      csess[msg.id] = ws;
      ident.delete(msg.ident);
      break;
    }
    case "upstream_msg":
      if (!csess.hasOwnProperty(msg.id)) return;
      csess[msg.id].send(msg.data);
      break;
    case "stats":
      stats = msg.data;
      break;
  }
};

// WS - Broadcast message to every existing sockets
function _req(id, sid, filters) {
  worker.postMessage({
    type: "req",
    id,
    sid,
    filters
  });
}

function _close(id, sid) {
  worker.postMessage({
    type: "close",
    id,
    sid
  });
}

function _event(id, eventBlob) {
  worker.postMessage({
    type: "event",
    id,
    event: eventBlob
  });
}

function _auth(id, pubkey) {
  worker.postMessage({
    type: "auth",
    id,
    pubkey
  });
}

function _destroy(id) {
  worker.postMessage({
    type: "destroy",
    id
  });
}

function getIdleSess(ws) {
  const data = {
    ip: ws.ip,
    pubkey: ws.pubkey,
    rejectKinds: ws.rejectKinds,
    acceptKinds: ws.acceptKinds,
    forcedLimit: ws.forcedLimit,
    accurateMode: ws.accurateMode,
    saveMode: ws.saveMode
  };

  worker.postMessage({
    type: "getsess",
    ident: ws.ident,
    data
  });

  return new Promise(resolve => ws.onready = resolve);
}

worker.on("message", handleWorker);
worker.on("error", err => {
  console.error("\n***");
  console.error("*** PANIC - Worker Process Error");
  console.error(err);
});

worker.on("exit", _ => {
  console.error("*** PANIC - End of Panic. Not doing anything.");
  console.error("***\n");
  process.exit(6);
});

function getStat(n) {
  if (!n) return stats;
  return stats[n] || zeroStats;
}

module.exports = {
  handleConnection,
  getStat
}
