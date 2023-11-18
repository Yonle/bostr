const WebSocket = require("ws");
const { validateEvent, nip19 } = require("nostr-tools");
const auth = require("./auth.js");
const nip42 = require("./nip42.js");

let { relays, tmp_store, log_about_relays, authorized_keys, private_keys, reconnect_time } = require("./config");

const socks = new Set();
const csess = new Map();

authorized_keys = authorized_keys?.map(i => i.startsWith("npub") ? nip19.decode(i).data : i);

// CL - User socket
module.exports = (ws, req) => {
  let authKey = null;
  let authorized = true;

  ws.id = process.pid + Math.floor(Math.random() * 1000) + "_" + csess.size;
  ws.sess = new Map(); // contains filter submitted by clients. per subID
  ws.events = new Map(); // only to prevent the retransmit of the same event. per subID
  ws.my_events = new Set(); // for event retransmitting.
  ws.pendingEOSE = new Map(); // each contain subID

  if (authorized_keys?.length) {
    authKey = Date.now() + Math.random().toString(36);
    authorized = false;
    ws.send(JSON.stringify(["AUTH", authKey]));
  }

  console.log(process.pid, `->- ${req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address} connected as ${ws.id}`);
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
        ws.my_events.add(data[1]);
        bc(data, ws.id);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ":
        if (!authorized) return;
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "expected subID a string. but got the otherwise."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["NOTICE", "expected filter to be obj, instead gives the otherwise."]));
        if (ws.sess.has(data[1])) return ws.send(JSON.stringify(["NOTICE", "The same subscription ID is already available."]));
        ws.sess.set(data[1], data[2]);
        ws.events.set(data[1], new Set());
        bc(data, ws.id);
        if (data[2]?.limit < 1) return ws.send(JSON.stringify(["EOSE", data[1]]));
        ws.pendingEOSE.set(data[1], 0);
        break;
      case "CLOSE":
        if (!authorized) return;
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        ws.sess.delete(data[1]);
        ws.events.delete(data[1]);
        ws.pendingEOSE.delete(data[1]);
        bc(data, ws.id);
        break;
      case "AUTH":
        if (auth(authKey, authorized, authorized_keys, data[1], ws, req)) {
          ws.pubkey = data[1].pubkey;
          authorized = true;
          relays.forEach(_ => newConn(_, ws.id));
        }
        break;
      default:
        ws.send(JSON.stringify(["NOTICE", "error: unrecognized command."]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    console.log(process.pid, "---", "Sock", ws.id, "has disconnected.");
    csess.delete(ws.id);

    if (!authorized) return;
    terminate_sess(ws.id);
  });

  csess.set(ws.id, ws);
  if (authorized) relays.forEach(_ => newConn(_, ws.id));
}

// WS - Broadcast message to every existing sockets
function bc(msg, id) {
  for (sock of socks) {
    if (sock.id !== id) continue;
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.send(JSON.stringify(msg));
  }
}

// WS - Terminate all existing sockets that were for <id>
function terminate_sess(id) {
  for (sock of socks) {
    if (sock.id !== id) continue;
    sock.terminate();
    socks.delete(sock);
  }
}

// WS - Sessions
function newConn(addr, id) {
  if (!csess.has(id)) return;
  const client = csess.get(id);
  const relay = new WebSocket(addr, {
    headers: {
      "User-Agent": "Bostr; The nostr relay bouncer; https://github.com/Yonle/bostr"
    }
  });

  relay.id = id;
  relay.on('open', _ => {
    socks.add(relay); // Add this socket session to [socks]
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.log(process.pid, "---", `[${id}] [${socks.size}/${relays.length*csess.size}]`, relay.url, "is connected");

    for (i of client.my_events) {
      relay.send(JSON.stringify(i));
    }

    for (i of client.sess) {
      relay.send(JSON.stringify(["REQ", i[0], i[1]]));
    }
  });

  relay.on('message', data => {
    try {
      data = JSON.parse(data);
    } catch (error) {
      return console.error(error);
    }

    switch (data[0]) {
      case "EVENT": {
        if (data.length < 3 || typeof(data[1]) !== "string" || typeof(data[2]) !== "object") return;
        if (!client.sess.has(data[1])) return;
        const NotInSearchQuery = client.sess.get(data[1]).search && !data[2].content?.toLowerCase().includes(client.sess.get(data[1]).search?.toLowerCase());

        if (NotInSearchQuery) return;
        if (client.events.get(data[1]).has(data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        client.events.get(data[1]).add(data[2]?.id);
        client.send(JSON.stringify(data));

        // Now count for REQ limit requested by client.
        // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

        // Skip if EOSE has been omitted
        if (!client.pendingEOSE.has(data[1]) || !client.sess.get(data[1])?.limit) return;
        if (client.events.get(data[1]).size >= client.sess.get(data[1])?.limit) {
          // Once there are no remaining event, Do the instructed above.
          client.send(JSON.stringify(["EOSE", data[1]]));
          client.pendingEOSE.delete(data[1]);
        }
        break;
      }
      case "EOSE":
        if (!client.pendingEOSE.has(data[1])) return;
        client.pendingEOSE.set(data[1], client.pendingEOSE.get(data[1]) + 1);
        if (client.pendingEOSE.get(data[1]) < Array.from(relays).filter(_ => _.id === id).length) return;
        client.send(JSON.stringify(data));
        client.pendingEOSE.delete(data[1]);
        break;
      case "AUTH":
        if (!private_keys || typeof(data[1]) !== "string" || !client.pubkey) return;
        nip42(relay, client.pubkey, private_keys[client.pubkey], data[1]);
        break;
    }
  });

  relay.on('error', _ => {
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.error(process.pid, "-!-", `[${id}]`, relay.url, _.toString())
  });

  relay.on('close', _ => {
    socks.delete(relay) // Remove this socket session from [socks] list
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.log(process.pid, "-!-", `[${id}] [${socks.size}/${relays.length*csess.size}]`, "Disconnected from", relay.url);

    if (!csess.has(id)) return;
    setTimeout(_ => newConn(addr, id), reconnect_time || 5000); // As a bouncer server, We need to reconnect.
  });
}
