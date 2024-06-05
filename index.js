"use strict";

process.title = "Bostr (keeper)";

const config = require(process.env.BOSTR_CONFIG_PATH || "./config");

if (typeof(Bun) === "object") {
  console.log("You are running Bostr with Bun runtime.");
  console.log("Clustering will not work, But worker thread will continue to work.");
  return require("./http.js");
}

const cluster = require("node:cluster");
const fs = require("node:fs");
const os = require("node:os");

if (!process.env.NO_CLUSTERS && cluster.isPrimary) {
  const numClusters = process.env.CLUSTERS || config.clusters || (os.availableParallelism ? os.availableParallelism() : (os.cpus().length || 2))

  console.log(`Primary ${process.pid} is running. Will fork ${numClusters} clusters.`);

  // Fork workers.
  for (let i = 0; i < numClusters; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Cluster process ${worker.process.pid} died. Forking another one....`);
    cluster.fork();
  });

  return true;
}

require("./http.js");
