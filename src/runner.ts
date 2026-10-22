import * as path from 'path';
import { Worker } from 'worker_threads';
import { compare, type Result, type Side } from './core';
import type { FromWorker, ToWorker } from './worker';

/** A comparison replaced by a newer one for the same thing before it finished. */
export class Superseded extends Error {
  constructor() {
    super('superseded');
  }
}

interface Job {
  id: number;
  key: string;
  old: Side;
  new: Side;
  resolve(r: Result): void;
  reject(e: Error): void;
}

/** How long one comparison may take before it is stopped. */
const TIMEOUT_MS = 120_000;
/** The worker, and the loaded schemas it keeps, go away after this long without work. */
const IDLE_MS = 60_000;

/**
 * Runs comparisons one at a time in a worker thread. A newer comparison for the same key
 * (a document, a report) replaces one still waiting, and stops one already running.
 */
export class Runner {
  private worker?: Worker;
  private queue: Job[] = [];
  private running?: Job;
  private seq = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private script: string) {}

  static forExtension(extensionPath: string) {
    return new Runner(path.join(extensionPath, 'dist', 'worker.js'));
  }

  run(key: string, oldSide: Side, newSide: Side): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      for (const j of this.queue.filter((q) => q.key === key)) j.reject(new Superseded());
      this.queue = this.queue.filter((q) => q.key !== key);
      if (this.running?.key === key) this.stop(new Superseded());
      this.queue.push({ id: ++this.seq, key, old: oldSide, new: newSide, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.running || this.disposed) return;
    const job = this.queue.shift();
    if (!job) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.kill(), IDLE_MS);
      return;
    }
    clearTimeout(this.idle);
    const w = this.spawn();
    if (!w) {
      // No worker threads here: compare on this thread.
      this.running = job;
      try {
        this.finish(job, compare(job.old, job.new));
      } catch (e) {
        this.finish(job, undefined, e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }
    this.running = job;
    this.timeout = setTimeout(() => this.stop(new Error('The comparison took more than two minutes and was stopped.')), TIMEOUT_MS);
    w.postMessage({ type: 'compare', job: job.id, old: job.old, new: job.new } satisfies ToWorker);
  }

  private spawn(): Worker | undefined {
    if (this.worker) return this.worker;
    let w: Worker;
    try {
      w = new Worker(this.script);
    } catch {
      return undefined;
    }
    w.on('message', (m: FromWorker) => this.onMessage(w, m));
    w.on('error', (e: Error) => this.lost(w, e));
    w.on('exit', () => this.lost(w, new Error('The comparison stopped unexpectedly.')));
    w.unref();
    this.worker = w;
    return w;
  }

  private onMessage(w: Worker, m: FromWorker) {
    const job = this.running;
    if (w !== this.worker || !job || m.job !== job.id) return;
    if (m.result) this.finish(job, m.result);
    else this.finish(job, undefined, new Error(m.error ?? 'The comparison failed.'));
  }

  private finish(job: Job, r?: Result, e?: Error) {
    if (this.running !== job) return;
    clearTimeout(this.timeout);
    this.running = undefined;
    if (r) job.resolve(r);
    else job.reject(e!);
    this.pump();
  }

  /** Stops the running comparison: the worker goes, with whatever it was doing. */
  private stop(e: Error) {
    const job = this.running;
    this.kill();
    if (job) {
      clearTimeout(this.timeout);
      this.running = undefined;
      job.reject(e);
    }
    queueMicrotask(() => this.pump());
  }

  private lost(w: Worker, e: Error) {
    if (w !== this.worker) return;
    this.worker = undefined;
    const job = this.running;
    if (job) this.finish(job, undefined, e);
  }

  private kill() {
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    clearTimeout(this.timeout);
    this.kill();
    for (const j of this.queue.splice(0)) j.reject(new Superseded());
    if (this.running) this.running.reject(new Superseded());
    this.running = undefined;
  }
}
