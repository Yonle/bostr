"use strict";
const { version } = require("./package.json");
const WebSocket = require("ws");
const config = require("./config");
const http = require("http");
const http2 = require("http2");
const fs = require("fs");
const bouncer = require(`./bouncer.js`);

// For log
const curD = _ => (new Date()).toLocaleString("ia");
const log = _ => console.log(process.pid, curD(), "-", _);

// Server
let server = null;

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

const wss = new WebSocket.WebSocketServer({ noServer: true });
const lastConn = new Map();

const favicon = fs.existsSync(config.favicon) ? fs.readFileSync(config.favicon) : null;

server.on('request', (req, res) => {
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
      res.write("- " + _ + "\n");
    });

    res.write(`\nI have ${wss.clients.size} clients currently connected to this bouncer${(process.env.CLUSTERS || config.clusters) > 1 ? " on this cluster" : ""}.\n`);
    if (config?.authorized_keys?.length) res.write("\nNOTE: This relay has configured for personal use only. Only authorized users could use this bostr relay.\n");
    res.write(`\nConnect to this bouncer with nostr client: ${req.headers["x-forwarded-proto"]?.replace(/http/i, "ws") || (server.isStandaloneHTTPS ? "wss" : "ws")}://${req.headers.host}${req.url}\n\n---\n`);
    res.end(`Powered by Bostr (${version}) - Open source Nostr bouncer\nhttps://github.com/Yonle/bostr`);
  } else if (req.url.startsWith("/favicon") && favicon) {
    res.writeHead(200, { "Content-Type": "image/" + config.favicon?.split(".").pop() });
    res.end(favicon);
  } else {
    res.writeHead(404).end("What are you looking for?");
  }
});

server.on('upgrade', (req, sock, head) => {
  for (i of lastConn) {
    if (config.incomming_ratelimit > (Date.now() - i[1])) continue;
    lastConn.delete(i[0]);
  }

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || sock.address()?.address;
  const lv = lastConn.get(ip) // last visit
  if (config.incomming_ratelimit && (config.incomming_ratelimit > (Date.now() - lv))) {
    log(`Rejected connection from ${ip} as the last connection was ${Date.now() - lv} ms ago.`);
    lastConn.set(ip, Date.now());
    return sock.destroy(); // destroy.
  }

  lastConn.set(ip, Date.now());

  req.on('close', _ => lastConn.set(ip, Date.now()));
  wss.handleUpgrade(req, sock, head, _ => bouncer(_, req));
});

const listened = server.listen(process.env.PORT || config.port, config.address || "0.0.0.0", _ => {
  log("Bostr is now listening on " + `${server.isStandaloneHTTPS ? "wss" : "ws"}://` + (config.address || "0.0.0.0") + ":" + config.port);
});
