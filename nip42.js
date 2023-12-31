const { getEventHash, getSignature, nip19 } = require("nostr-tools");

module.exports = (relay, pubkey, privkey, challenge) => {
  if (!privkey) return;
  if (privkey.startsWith("nsec")) privkey = nip19.decode(privkey).data;

  let signed_challenge = {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 22242,
    tags: [
      ["relay", relay.url],
      ["challenge", challenge]
    ],
    content: ""
  }

  signed_challenge.id = getEventHash(signed_challenge);
  signed_challenge.sig = getSignature(signed_challenge, privkey);
  relay.send(JSON.stringify(["AUTH", signed_challenge]));
}
