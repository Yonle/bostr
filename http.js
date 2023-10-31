const WebSocket = require("ws");
const config = require("./config");
const http = require("http");

const handleBouncer = require(`./bouncer/bouncer${config?.mode || 1}.js`);

// For log
const curD = _ => (new Date()).toLocaleString("ia");
const log = _ => console.log(process.pid, curD(), "-", _);

// Server
const server = http.createServer()
const wss = new WebSocket.WebSocketServer({ noServer: true });

server.on('request', (req, res) => {
  log(`${req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.address()?.address} - ${req.method} ${req.url}`)

  if (req.headers.accept?.includes("nostr"))
    return res.writeHead(200, {
      "Content-Type": "application/json"
    }).end(JSON.stringify(config.server_meta));

  if (req.url === "/") {
    res.write("Hello. This nostr bouncer (bostr) is bouncing the following relays:\n\n");
    config.relays.forEach(_ => {
      res.write("- " + _ + "\n");
    });

    res.write(`\nI have ${wss.clients.size} clients currently connected to this bouncer.\n`);
    res.write(`\nConnect to this bouncer with nostr client: ws://${req.headers.host} or wss://${req.headers.host}\n\n---\n`);
    res.end("Powered by Bostr - Open source nostr Bouncer\nhttps://github.com/Yonle/bostr");
  } else {
    res.writeHead(404).end("What are you looking for?");
  }
});

server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, _ => handleBouncer(_, req));
});

const listened = server.listen(process.env.PORT || config.port, config.address || "0.0.0.0", _ => {
  log("Bostr is now listening on " + "ws://" + (config.address || "0.0.0.0") + ":" + config.port);
});
