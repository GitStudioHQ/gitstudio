import type { Worker } from "node:worker_threads";
import { inProcessMath, Superseded, type StagingMath } from "@gitstudio/git-service/stagingMath";
import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";
import type { Hunk, LineRange } from "@gitstudio/engine/staging/applyLineChanges";

/**
 * The staging diffs on a worker thread, so no file — not a 3,000-line one
 * whose every line changed (#145) — can block the extension host while it is
 * diffed. See git-service/stagingMath.ts for why, and stagingWorker.ts for the
 * other end.
 *
 * One worker, one job at a time, in order. A job's `key` (the gutter passes
 * its document) makes it supersedable: a newer job, or `cancel`, for the same
 * key drops a queued one, and a RUNNING one is stopped the only way a
 * synchronous diff can be — the worker is terminated and a fresh one started
 * for whatever is next. The dropped job rejects with `Superseded`.
 *
 * If the worker cannot start, or dies, the jobs run in-process: slower to
 * answer on the worst files, never wrong and never lost.
 */

export type StagingJob =
  | { id: number; op: "changeBlocks"; args: [string, string, string] }
  | { id: number; op: "hunks"; args: [string, string] }
  | { id: number; op: "apply"; args: [string, string, LineRange[]] };

export type StagingReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type JobSpec = DistributiveOmit<StagingJob, "id">;

interface Pending {
  job: StagingJob;
  key?: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class WorkerStagingMath implements StagingMath {
  private worker: Worker | undefined;
  private broken = false;
  private disposed = false;
  private nextId = 1;
  private readonly queue: Pending[] = [];
  private running: Pending | undefined;

  constructor(private readonly spawn: () => Worker) {}

  changeBlocks(head: string, index: string, working: string, key?: string): Promise<ChangeBlock[]> {
    return this.submit({ op: "changeBlocks", args: [head, index, working] }, key) as Promise<ChangeBlock[]>;
  }

  hunks(original: string, modified: string): Promise<Hunk[]> {
    return this.submit({ op: "hunks", args: [original, modified] }) as Promise<Hunk[]>;
  }

  apply(original: string, modified: string, selected: LineRange[]): Promise<string> {
    return this.submit({ op: "apply", args: [original, modified, selected] }) as Promise<string>;
  }

  cancel(key: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].key === key) this.queue.splice(i, 1)[0].reject(new Superseded());
    }
    if (this.running?.key === key) {
      const stale = this.running;
      this.running = undefined;
      this.stopWorker();
      stale.reject(new Superseded());
      this.pump();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
    const dropped = [...(this.running ? [this.running] : []), ...this.queue.splice(0)];
    this.running = undefined;
    for (const p of dropped) p.reject(new Superseded());
  }

  private submit(spec: JobSpec, key?: string): Promise<unknown> {
    if (key !== undefined) this.cancel(key);
    return new Promise((resolve, reject) => {
      const job = { ...spec, id: this.nextId++ } as StagingJob;
      this.queue.push({ job, key, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.running || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    if (this.disposed) {
      next.reject(new Superseded());
      this.pump();
      return;
    }
    const worker = this.broken ? undefined : this.ensureWorker();
    if (!worker) {
      this.runInProcess(next);
      return;
    }
    this.running = next;
    worker.ref();
    worker.postMessage(next.job);
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = this.spawn();
    } catch {
      this.broken = true;
      return undefined;
    }
    worker.on("message", (reply: StagingReply) => {
      const p = this.running;
      if (worker !== this.worker || !p || p.job.id !== reply.id) return;
      this.running = undefined;
      worker.unref();
      if (reply.ok) p.resolve(reply.value);
      else p.reject(new Error(reply.error));
      this.pump();
    });
    // A worker that dies (or never starts) under a job: that job, and every
    // later one, runs in-process.
    const lost = (): void => {
      if (worker !== this.worker) return;
      this.worker = undefined;
      this.broken = true;
      const p = this.running;
      this.running = undefined;
      if (p) this.runInProcess(p);
      else this.pump();
    };
    worker.on("error", lost);
    worker.on("exit", lost);
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  private runInProcess(p: Pending): void {
    const { job } = p;
    const answer =
      job.op === "changeBlocks"
        ? inProcessMath.changeBlocks(...job.args)
        : job.op === "hunks"
          ? inProcessMath.hunks(...job.args)
          : inProcessMath.apply(...job.args);
    answer.then(p.resolve, p.reject).finally(() => this.pump());
  }
}
