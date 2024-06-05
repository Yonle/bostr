"use strict";
// Anything about handling client connections is in this code.

const { Worker } = require("node:worker_threads");
const { version } = require("./package.json");
const querystring = require("node:querystring");
const { validateEvent, nip19 } = require("nostr-tools");
const auth = require("./auth.js");

let { allowed_publishers, approved_publishers, blocked_publishers, log_about_relays, authorized_keys, private_keys, noscraper } = require(process.env.BOSTR_CONFIG_PATH || "./config");

log_about_relays = process.env.LOG_ABOUT_RELAYS || log_about_relays;
authorized_keys = authorized_keys?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
allowed_publishers = allowed_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
blocked_publishers = blocked_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);

for (const key in private_keys) {
  if (!key.startsWith("npub")) continue;
  private_keys[nip19.decode(key).data] = private_keys[key];

  delete private_keys[key];
}

// The following warning will be removed in the next 2 stable release
if (approved_publishers?.length) {
  allowed_publishers = approved_publishers?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);
  console.warn(process.pid, "[config]");
  console.warn(process.pid, "[config]", "!!! Attention !!!");
  console.warn(process.pid, "[config]", "approved_publishers is deprecated. rename as allowed_publishers");
  console.warn(process.pid, "[config]");
}

const worker = new Worker(__dirname + "/worker_bouncer.js", { name: "Bostr (worker)" });

const csess = {};
const idents = {};

let zeroStats = {
  raw_rx: 0,
  rx: 0,
  tx: 0,
  f: 0
}
let stats = {};

function handleConnection(ws, req, onClose) {
  let query = querystring.parse(req.url.slice(2));
  let authKey = null;
  let authorized = true;
  let sessStarted = false;

  ws.onready = new Set();
  ws.ident = Date.now() + Math.random().toString(36);
  ws.id = null;
  ws.ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address;
  ws.pubkey = null;
  ws.rejectKinds = query.reject?.split(",").map(_ => parseInt(_));
  ws.acceptKinds = query.accept?.split(",").map(_ => parseInt(_));
  ws.forcedLimit = parseInt(query.limit);
  ws.accurateMode = parseInt(query.accurate);
  ws.saveMode = parseInt(query.save);

  idents[ws.ident] = ws;

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
        if (!authorized)
          return ws.send(JSON.stringify(["OK", data[1].id, false, "auth-required: authentication is required to perform this action."]));

        if (
          allowed_publishers?.length &&
          !allowed_publishers?.includes(data[1].pubkey)
        ) return ws.send(JSON.stringify(["OK", data[1]?.id, false, "rejected: unauthorized"]));

        if (!sessStarted) {
          console.log(process.pid, `>>>`, `${ws.ip} executed ${data[0]} command for the first. Initializing session`);
          await getIdleSess(ws);
          _auth(ws.id, ws.pubkey);
          sessStarted = true;
        }

        _event(ws.id, data[1]);
        break;
      case "REQ": {
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: expected subID a string. but got the otherwise."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["CLOSED", data[1], "error: expected filter to be obj, instead gives the otherwise."]));
        if (!authorized)
          return ws.send(JSON.stringify(["CLOSED", data[1], "auth-required: authentication is required to perform this action."]));

        if (!sessStarted) {
          console.log(process.pid, `>>>`, `${ws.ip} executed ${data[0]} command for the first. Initializing session`);
          await getIdleSess(ws);
          _auth(ws.id, ws.pubkey);
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
          ws.pubkey = data[1].pubkey;
          console.log(process.pid, "---", ws.ip, "successfully authorized as", ws.pubkey, private_keys[ws.pubkey] ? "(admin)" : "(user)");
          if (authorized) return;
          authorized = true;
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

    delete idents[ws.ident];

    console.log(process.pid, "---", `${ws.ip} disconnected`);

    if (!sessStarted) return;
    _destroy(ws.id, ws.ident);
    delete csess[ws.id];
  });
}

// Below code is for talking to worker.

function resolveClient(ws) {
  for (const resolve of ws.onready) {
    ws.onready.delete(resolve);
    resolve();
  }
}

function handleWorker(msg) {
  switch (msg.type) {
    case "sessreg": {
      if (!idents.hasOwnProperty(msg.ident)) return _destroy(msg.id);
      const ws = idents[msg.ident];
      if (ws.id === msg.id) return resolveClient(ws); // if existing is the same as the current one, just poke ready.
      ws.id = msg.id;
      resolveClient(ws);
      csess[msg.id] = ws;
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

function _destroy(id, ident) {
  worker.postMessage({
    type: "destroy",
    id,
    ident
  });
}

function getIdleSess(ws) {
  const data = {
    ip: ws.ip,
    ident: ws.ident,
    pubkey: ws.pubkey,
    rejectKinds: ws.rejectKinds,
    acceptKinds: ws.acceptKinds,
    forcedLimit: ws.forcedLimit,
    accurateMode: ws.accurateMode,
    saveMode: ws.saveMode
  };

  worker.postMessage({
    type: "getsess",
    data
  });

  return new Promise(resolve => ws.onready.add(resolve));
}

worker.ref();

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
