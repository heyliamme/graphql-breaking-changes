// Runs comparisons off the extension host thread. Both sides arrive complete (the host
// read every file, and knows what may be read); see runner.ts.
import { parentPort } from 'worker_threads';
import { compare, type Result, type Side } from './core';

export type ToWorker = { type: 'compare'; job: number; old: Side; new: Side };

export type FromWorker = { type: 'done'; job: number; result?: Result; error?: string };

const port = parentPort!;

port.on('message', (m: ToWorker) => {
  try {
    const result = compare(m.old, m.new);
    port.postMessage({ type: 'done', job: m.job, result } satisfies FromWorker);
  } catch (e) {
    port.postMessage({ type: 'done', job: m.job, error: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
  }
});
