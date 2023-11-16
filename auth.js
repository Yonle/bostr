const { validateEvent, verifySignature } = require("nostr-tools");

module.exports = (authKey, authorized, authorized_keys, data, ws, req) => {
  if (!validateEvent(data)) {
    ws.send(JSON.stringify(["NOTICE", "error: invalid challenge response."]));
    return false;
  }

  if (!verifySignature(data)) {
    ws.send(JSON.stringify(["OK", data.id, false, "signature verification failed."]));
    return false;
  }

  if (!authorized_keys.includes(data.pubkey)) {
    ws.send(JSON.stringify(["OK", data.id, false, "unauthorized."]));
    return false;
  }

  if (data.kind != 22242) {
    ws.send(JSON.stringify(["OK", data.id, false, "not kind 22242."]));
    return false;
  }

  if (authorized) {
    ws.send(JSON.stringify(["OK", data.id, false, "already authorized."]));
    return false;
  }

  const tags = new Map(data.tags);
  if (!tags.get("relay").includes(req.headers.host)) {
    ws.send(JSON.stringify(["OK", data.id, false, "unmatched relay url."]));
    return false;
  };

  if (tags.get("challenge") !== authKey) {
    ws.send(JSON.stringify(["OK", data.id, false, "unmatched challenge string."]));
    return false;
  }

  ws.send(JSON.stringify(["OK", data.id, true, `Welcome ${data.pubkey}`]));
  return true;
}
