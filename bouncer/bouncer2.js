const SQLite = require("better-sqlite3");
const WebSocket = require("ws");
const { relays, tmp_store, log_about_relays } = require("../config");
const socks = new Set();
const sess = new SQLite((process.env.IN_MEMORY || tmp_store != "disk") ? null : (__dirname + "/../.temporary.db"));
const csess = new Map();

const pendingEOSE = new Map(); // per sessID
const reqLimit = new Map(); // per sessID
const searchQuery = new Map(); // per sessID

// Handle database....
sess.unsafeMode(true);

// Temporary database.
sess.exec("CREATE TABLE IF NOT EXISTS sess (cID TEXT, subID TEXT, filter TEXT);");
sess.exec("CREATE TABLE IF NOT EXISTS events (cID TEXT, subID TEXT, eID TEXT);"); // To prevent transmitting duplicates
sess.exec("CREATE TABLE IF NOT EXISTS recentEvents (cID TEXT, data TEXT);");

// CL - User socket
module.exports = (ws, req) => {
  ws.id = process.pid + Math.floor(Math.random() * 1000) + "_" + csess.size;

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
        if (!data[1]?.id) return ws.send(JSON.stringify(["NOTICE", "error: no event id."]));
        sess.prepare("INSERT INTO recentEvents VALUES (?, ?);").run(ws.id, JSON.stringify(data));
        bc(data, ws.id);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ":
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["NOTICE", "expected filter to be obj, instead gives the otherwise."]));
        // eventname -> 1_eventname
        bc(data, ws.id);
        sess.prepare("INSERT INTO sess VALUES (?, ?, ?);").run(ws.id, data[1], JSON.stringify(data[2]));
        if (data[2]?.search) searchQuery.set(ws.id + ":" + data[1], data[2]?.search);
        if (data[2]?.limit < 1) return ws.send(JSON.stringify(["EOSE", data[1]]));
        pendingEOSE.set(ws.id + ":" + data[1], 0);
        reqLimit.set(ws.id + ":" + data[1], data[2]?.limit);
        break;
      case "CLOSE":
        if (typeof(data[1]) !== "string") return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        bc(data, ws.id);
        pendingEOSE.delete(ws.id + ":" + data[1]);
        reqLimit.delete(ws.id + ":" + data[1]);
        searchQuery.delete(ws.id + ":" + data[1]);
        sess.prepare("DELETE FROM sess WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        sess.prepare("DELETE FROM events WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        break;
      default:
        console.warn(process.pid, "---", "Unknown command:", data.join(" "));
        ws.send(JSON.stringify(["NOTICE", "error: unrecognized command."]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    console.log(process.pid, "---", "Sock", ws.id, "has disconnected.");
    csess.delete(ws.id);

    sess.prepare("DELETE FROM sess WHERE cID = ?;").run(ws.id);
    sess.prepare("DELETE FROM events WHERE cID = ?;").run(ws.id);
    sess.prepare("DELETE FROM recentEvents WHERE cID = ?;").run(ws.id);
    terminate_sess(ws.id);
  });

  // Chill down first buddy....
  ws.pause();

  csess.set(ws.id, ws);
  relays.forEach(_ => newConn(_, ws.id));
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

  for (sub of pendingEOSE) {
    if (!sub[0].startsWith(id)) continue;
    pendingEOSE.delete(sub[0]);
  }

  for (sub of reqLimit) {
    if (!sub[0].startsWith(id)) continue;
    reqLimit.delete(sub[0]);
  }

  for (sub of searchQuery) {
    if (!sub[0].startsWith(id)) continue;
    searchQuery.delete(sub[0]);
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
  relay.on('open', _ => {
    socks.add(relay); // Add this socket session to [socks]
    if (process.env.LOG_ABOUT_RELAYS || log_about_relays) console.log(process.pid, "---", `[${id}] [${socks.size}/${relays.length*csess.size}]`, relay.url, "is connected");
    if (csess.get(id)?.isPaused) csess.get(id).resume();

    for (i of sess.prepare("SELECT data FROM recentEvents WHERE cID = ?;").iterate(id)) {
      if (relay.readyState >= 2) break;
      relay.send(i.data);
    }

    for (i of sess.prepare("SELECT subID, filter FROM sess WHERE cID = ?;").iterate(id)) {
      if (relay.readyState >= 2) break;
      relay.send(JSON.stringify(["REQ", i.subID, JSON.parse(i.filter)]));
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
        const NotInSearchQuery = searchQuery.has(id + ":" + data[1]) && !data[2]?.content?.toLowerCase()?.includes(searchQuery.get(id + ":" + data[1]).toLowerCase());

        if (NotInSearchQuery) return;
        if (!sess.prepare("SELECT * FROM sess WHERE cID = ? AND subID = ?;").get(id, data[1])) return;
        if (sess.prepare("SELECT * FROM events WHERE cID = ? AND subID = ? AND eID = ?;").get(id, data[1], data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        sess.prepare("INSERT INTO events VALUES (?, ?, ?);").run(id, data[1], data[2]?.id);
        csess.get(id)?.send(JSON.stringify(data));

        // Now count for REQ limit requested by client.
        // If it's at the limit, Send EOSE to client and delete pendingEOSE of subID

        // Skip if EOSE has been omitted
        const subID = id + ":" + data[1];
        if (!pendingEOSE.has(subID)) return;

        let remainingEvents = reqLimit.get(subID);

        if (remainingEvents) {
          remainingEvents--;
          reqLimit.set(subID, remainingEvents);
        }

        if (remainingEvents < 1) {
          // Once there are no remaining event, Do the instructed above.
          csess.get(id)?.send(JSON.stringify(["EOSE", data[1]]));
          pendingEOSE.delete(subID);
          reqLimit.delete(subID);
        }
        break;
      }
      case "EOSE":
        if (!pendingEOSE.has(id + ":" + data[1])) return;
        pendingEOSE.set(id + ":" + data[1], pendingEOSE.get(id + ":" + data[1]) + 1);
        if (pendingEOSE.get(id + ":" + data[1]) < Array.from(relays).filter(_ => _.id === id).length) return;
        csess.get(id)?.send(JSON.stringify(data));
        pendingEOSE.delete(id + ":" + data[1]);
        reqLimit.delete(id + ":" + data[1]);
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
    setTimeout(_ => newConn(addr, id), 5000); // As a bouncer server, We need to reconnect.
  });
}
