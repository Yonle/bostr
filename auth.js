"use strict";
const { validateEvent, verifyEvent } = require("nostr-tools");
const { authorized_keys, private_keys, noscraper } = require(process.env.BOSTR_CONFIG_PATH || "./config");

module.exports = (authKey, data, ws, req) => {
  if (!authorized_keys?.length && !Object.keys(private_keys).length && !noscraper) return; // do nothing
  if (!validateEvent(data) || !verifyEvent(data)) {
    ws.send(JSON.stringify(["NOTICE", "error: invalid challenge response."]));
    return false;
  }

  if (!authorized_keys?.includes(data.pubkey) && !private_keys[data.pubkey] && !noscraper) {
    ws.send(JSON.stringify(["OK", data.id, false, "unauthorized."]));
    return false;
  }

  if (data.kind != 22242) {
    ws.send(JSON.stringify(["OK", data.id, false, "not kind 22242."]));
    return false;
  }

  const tags = Object.fromEntries(data.tags);

  if (!tags.relay?.includes(req.headers.host)) {
    ws.send(JSON.stringify(["OK", data.id, false, "unmatched relay url."]));
    return false;
  };

  if (tags.challenge !== authKey) {
    ws.send(JSON.stringify(["OK", data.id, false, "unmatched challenge string."]));
    return false;
  }

  ws.send(JSON.stringify(["OK", data.id, true, `Hello ${data.pubkey}`]));
  return true;
}
