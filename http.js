"use strict";
const { version } = require("./package.json");
const WebSocket = require("ws");
const http = require("http");
const http2 = require("http2");
const fs = require("fs");
const bouncer = require(`./bouncer.js`);

// For log
const curD = _ => (new Date()).toLocaleString("ia");
const log = _ => console.log(process.pid, curD(), "-", _);

// Server
let server = null;
let config = require(process.env.BOSTR_CONFIG_PATH || "./config");

config.server_meta.version = version;

if (
  fs.existsSync(config.https?.privKey) &&
  fs.existsSync(config.https?.certificate)
) {
  let http2_options = {
    allowHTTP1: true,
    key: fs.readFileSync(config.https?.privKey),
    cert: fs.readFileSync(config.https?.certificate),
    noDelay: true,
    dhparam: "auto",
    paddingStrategy: http2.constants.PADDING_STRATEGY_MAX
  }

  if (fs.existsSync(config.https?.ticketKey))
    http2_options.ticketKeys = fs.readFileSync(config.https?.ticketKey);

  server = http2.createSecureServer(http2_options);
  server.isStandaloneHTTPS = true;
} else {
  server = http.createServer({ noDelay: true })
  server.isStandaloneHTTPS = false;
}

const wss = new WebSocket.WebSocketServer({
  noServer: true,
  allowSynchronousEvents: true,
  perMessageDeflate: config.perMessageDeflate || true
});
const lastConn = new Map();

const favicon = fs.existsSync(config.favicon) ? fs.readFileSync(config.favicon) : null;

server.on('request', (req, res) => {
  const globalStat = bouncer.getStat("_global");
  const serverAddr = `${req.headers["x-forwarded-proto"]?.replace(/http/i, "ws") || (server.isStandaloneHTTPS ? "wss" : "ws")}://${req.headers.host}${req.url}`;
  log(`${req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address} - ${req.method} ${req.url} [${req.headers["user-agent"] || ""}]`)

  if (req.headers.accept?.includes("application/nostr+json"))
    return res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }).end(JSON.stringify(config.server_meta));

  if (req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });
    res.write("Hello. This nostr bouncer (bostr) is bouncing the following relays:\n\n");
    config.relays.forEach(_ => {
      const { raw_rx, rx, tx, f } = bouncer.getStat(_);
      res.write("- " + _ + ` (raw_rx: ${raw_rx}; rx: ${rx}; tx: ${tx}; fail: ${f})` + "\n");
    });

    res.write(`\nI have ${wss.clients.size} clients currently connected to this bouncer${(process.env.CLUSTERS || config.clusters) > 1 ? " on this cluster" : ""}.\n`);

    res.write(`\nAll bouncer activities in total:`);
    res.write(`\n- raw_rx: ${globalStat.rx}`);
    res.write(`\n- rx: ${globalStat.rx}`);
    res.write(`\n- tx: ${globalStat.tx}`);
    res.write(`\n- fail: ${globalStat.f}`);

    res.write(`\n\nStatistics legends:`);
    res.write(`\n- raw_rx: received events from upstream relays`);
    res.write(`\n- rx: received events from upstream relays that has been forwarded to clients`);
    res.write(`\n- tx: succesfully transmitted events that has been forwarded to upstream relays`);
    res.write(`\n- fail: failed transmissions or upstream errors\n`);

    if (config?.authorized_keys?.length) res.write("\nNOTE: This relay has configured for personal use only. Only authorized users could use this bostr relay.\n");
    res.write(`\nConnect to this bouncer with nostr client: ${serverAddr}`);
    res.write(`\n\n- To make connection that only send whitelisted kind of events, Connect:`);
    res.write(`\n  ${serverAddr}?accept=0,1`);
    res.write(`\n  (Will only send events with kind 0, and 1)`);
    res.write(`\n\n- To make connection that do not send blacklisted kind of events, Connect:`);
    res.write(`\n  ${serverAddr}?reject=3,6,7`);
    res.write(`\n  (Will not send events with kind 3, 6, and 7)`);
    res.write(`\n\n- To make connection that override client's REQ limit, Connect:`);
    res.write(`\n  ${serverAddr}?limit=50 or ${serverAddr}?accurate=1&limit=50`);
    res.write(`\n  (Will override REQ limit from client to 50 if exceeds)`);
    res.write(`\n\n- To connect with accurate bouncing mode${config.pause_on_limit ? "" : " (Default)"}, Connect:`);
    res.write(`\n  ${serverAddr}?accurate=1`);
    res.write(`\n  (May consume lot of bandwidths)`);
    res.write(`\n\n- To connect with save mode${config.pause_on_limit ? " (Default)" : ""}, Connect:`);
    res.write(`\n  ${serverAddr}?save=1`);
    res.write(`\n  (Saves bandwidth usage)`);
    res.end(`\n\n---\nPowered by Bostr (${version}) - Open source Nostr bouncer\nhttps://github.com/Yonle/bostr`);
  } else if (req.url.includes("favicon") && favicon) {
    res.writeHead(200, { "Content-Type": "image/" + config.favicon?.split(".").pop() });
    res.end(favicon);
  } else {
    res.writeHead(404).end("What are you looking for?");
  }
});

server.on('upgrade', (req, sock, head) => {
  for (const i of lastConn) {
    if (config.incomming_ratelimit > (Date.now() - i[1])) continue;
    lastConn.delete(i[0]);
  }

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || sock.address()?.address;

  if (config.blocked_hosts && config.blocked_hosts.includes(ip)) return sock.destroy();
  const lv = lastConn.get(ip) // last visit
  if (config.incomming_ratelimit && (config.incomming_ratelimit > (Date.now() - lv))) {
    log(`Rejected connection from ${ip} as the last connection was ${Date.now() - lv} ms ago.`);
    lastConn.set(ip, Date.now());
    return sock.destroy(); // destroy.
  }

  lastConn.set(ip, Date.now());

  wss.handleUpgrade(req, sock, head, _ => bouncer.handleConnection(_, req, _ => lastConn.set(ip, Date.now())));
});

const listened = server.listen(process.env.PORT || config.port, config.address || "0.0.0.0", _ => {
  log("Bostr is now listening on " + `${server.isStandaloneHTTPS ? "wss" : "ws"}://` + (config.address || "0.0.0.0") + ":" + config.port);
});
