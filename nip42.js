"use strict";
const { threadId } = require("node:worker_threads");
const { finalizeEvent, nip19 } = require("nostr-tools");

module.exports = (relay, pubkey, privkey, challenge) => {
  if (!privkey) return;
  if (privkey.startsWith("nsec")) privkey = nip19.decode(privkey).data;

  let signed_challenge = finalizeEvent({
    created_at: Math.floor(Date.now() / 1000),
    kind: 22242,
    tags: [
      ["relay", relay.url],
      ["challenge", challenge]
    ],
    content: ""
  }, privkey);

  relay.send(JSON.stringify(["AUTH", signed_challenge]));

  console.log(threadId, "-", relay.id, "NIP-42: Sending Signed Challenge to", relay.url);
}
