#!/usr/bin/env node
"use strict";
const { version } = require("./package.json");
const { nip19 } = require("nostr-tools")
const fs = require("fs");
const cluster = require("cluster");
const argv = process.argv.slice(2);

if (cluster.isPrimary) console.log(`Bostr ${version}\n`);

function showHelp() {
  console.log(
    "Usage: bostr [command] (argv)\n" +
    "Available command:\n" +
    "  makeconf [conffile]   - Make config file\n" +
    "  checkconf [conffile]  - Check config file\n" +
    "  start [conffile]      - Run bostr with specified config\n" +
    "  hexconverter [nip19]  - Convert NIP-19 string to hex\n" +
    "  testworker [conffile] - Test worker with specified bostr config\n" +
    "  help                  - Show this help text\n\n" +
    "Software is licensed under BSD-3-Clause\n" +
    "https://codeberg.org/Yonle/bostr"
  );
}

function readPath(p) {
  return p.startsWith("/") ? p : process.cwd() + "/" + p;
}

switch (argv[0]) {
  case "makeconf":
    if (!argv[1]) return console.log("Usage: bostr makeconf [conffile]");
    if (fs.existsSync(argv[1])) {
      console.error("The specified config already exists.");
      return process.exit(8);
    }

    fs.copyFileSync(__dirname + "/config.js.example", argv[1]);
    console.log(`Succesfully copied example config file into ${argv[1]}`);
    console.log(`Edit ${argv[1]} with your editor and start with the following command:`);
    console.log(`  $ bostr start ${argv[1]}\n`);
    break;
  case "checkconf": {
    if (!argv[1]) return console.log("Usage: bostr checkconf [conffile]");
    if (!fs.existsSync(argv[1])) {
      console.error("Config not exists.");
      return process.exit(254);
    }

    const masterConf = Object.keys(require("./config.js.example"));
    const currentConf = Object.keys(require(readPath(argv[1])));
    const unknown = currentConf.filter(i => !masterConf.includes(i))
    const missing = masterConf.filter(i => !currentConf.includes(i))

    if (unknown.length) console.log("Unknown Field:\n- " + unknown.join("\n- "));
    if (missing.length) {
      console.log("Missing Field:\n- " + missing.join("\n- "));
      console.log("\nPlease check your config and try again.");
      return process.exit(1);
    } else {
      console.log("\nNo config changes needed.");
    }
    break;
  }
  case "start":
    if (!argv[1]) return console.log("Usage: bostr start [conffile]");
    if (!fs.existsSync(argv[1])) {
      console.error("Config not exists.");
      return process.exit(254);
    }

    process.env.BOSTR_CONFIG_PATH = readPath(argv[1]);
    require("./index.js");
    break;
  case "testworker":
    if (!argv[1]) return console.log("Usage: bostr testworker [conffile]");
    if (!fs.existsSync(argv[1])) {
      console.error("Config not exists.");
      return process.exit(254);
    }

    process.env.BOSTR_CONFIG_PATH = readPath(argv[1]);

    console.log("Press CTRL + C to stop the test.");
    console.log("Using config:", process.env.BOSTR_CONFIG_PATH);
    require("./testworker.js");
    break;
  case "hexconverter":
    if (!argv[1]) return console.log("Usage: bostr hexconverter [npub|nsec|....] ....");
    for (const i of argv.slice(1)) {
      console.log(nip19.decode(i).data);
    }
    break;
  default:
    if (argv[0] && (argv[0] !== "help")) {
      console.error("Unrecognized command:", argv[0]);
      return process.exit(100)
    }

    showHelp();
    process.exit(1);
    break;
}
