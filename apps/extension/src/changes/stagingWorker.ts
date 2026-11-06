// The staging diffs, on a worker thread (see git-service/stagingMath.ts).
// Bundled on its own as dist/stagingWorker.js: no vscode, no git, only the
// engine's pure diff functions, one job at a time.

import { parentPort } from "node:worker_threads";
import { computeChangeBlocks } from "@gitstudio/engine/staging/blockStaging";
import { applySelectedChanges, computeHunks } from "@gitstudio/engine/staging/applyLineChanges";
import type { StagingJob, StagingReply } from "./workerStagingMath";

function run(job: StagingJob): unknown {
  switch (job.op) {
    case "changeBlocks":
      return computeChangeBlocks(job.args[0], job.args[1], job.args[2]);
    case "hunks":
      return computeHunks(job.args[0], job.args[1]);
    case "apply":
      return applySelectedChanges(job.args[0], job.args[1], job.args[2]);
  }
}

parentPort?.on("message", (job: StagingJob) => {
  let reply: StagingReply;
  try {
    reply = { id: job.id, ok: true, value: run(job) };
  } catch (e) {
    reply = { id: job.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort?.postMessage(reply);
});
