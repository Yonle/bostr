const cluster = require("cluster");
const fs = require("fs");
const os = require("os");

if (!process.env.NO_CLUSTERS && cluster.isPrimary) {
  try {
    fs.rmSync(".temporary.db");
  } catch {}

  const numClusters = process.env.CLUSTERS || (os.availableParallelism ? os.availableParallelism() : (os.cpus().length || 2))

  console.log(`Primary ${process.pid} is running. Will fork ${numClusters} clusters.`);

  // Fork workers.
  for (let i = 0; i < numClusters; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Forking another one....`);
    cluster.fork();
  });

  return true;
}

console.log(process.pid, "Worker spawned");
require("./http.js");
