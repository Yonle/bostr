"use strict";
const { Worker } = require("worker_threads");
const worker = new Worker(__dirname + "/worker_bouncer.js", { name: "Bostr (worker)" });

let id = null;

worker.on('message', msg => {
  console.log(msg);
  if (!id && msg.id) {
    id = msg.id;

    worker.postMessage({
      type: "req",
      id,
      sid: "TestWorker",
      filters: [{ kinds: [1] }]
    });
  }
});

worker.on("online", _ => {
  worker.postMessage({
    type: "getsess",
    data: { ip: "[TestWorker]", ident: "TestWorker" }
  })
});
