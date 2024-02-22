"use strict";
const { nip19 } = require("nostr-tools");
const argv = process.argv.slice(2);

if (!argv.length) return console.log("Usage: node hexconverter.js <npub....|nsec....> ....");

for (const i of argv) {
  console.log(nip19.decode(i).data);
}
