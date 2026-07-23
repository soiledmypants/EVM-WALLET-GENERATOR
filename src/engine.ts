import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { Criteria } from './pattern.js';

export interface FoundKey {
  address: string;
  privateKey: string;
  attemptsAtFind: number;
}

export interface EngineOptions {
  workers: number;
  count: number;
}

interface WorkerMessage {
  type: 'progress' | 'found';
  attempts?: number;
  address?: string;
  privateKey?: string;
}

/**
 * Spawns worker threads that grind random keypairs against the criteria.
 * Events: 'found' (FoundKey), 'done', 'stopped', 'error' (Error).
 */
export class VanityEngine extends EventEmitter {
  readonly criteria: Criteria;
  readonly workerCount: number;
  readonly count: number;

  attempts = 0;
  found: FoundKey[] = [];
  running = false;
  startedAt = 0;

  private workers: Worker[] = [];
  private window: Array<{ t: number; n: number }> = [];

  constructor(criteria: Criteria, opts: EngineOptions) {
    super();
    this.criteria = criteria;
    this.workerCount = opts.workers;
    this.count = opts.count;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: this.criteria,
      });
      worker.on('message', (m: WorkerMessage) => this.onMessage(m));
      worker.on('error', (err) => this.emit('error', err));
      this.workers.push(worker);
    }
  }

  private onMessage(m: WorkerMessage): void {
    if (!this.running) return;
    if (m.type === 'progress' && m.attempts) {
      this.attempts += m.attempts;
      const now = Date.now();
      this.window.push({ t: now, n: m.attempts });
      while (this.window.length > 0 && now - this.window[0].t > 5000) this.window.shift();
    } else if (m.type === 'found' && m.address && m.privateKey) {
      if (this.found.length >= this.count) return;
      const key: FoundKey = {
        address: m.address,
        privateKey: m.privateKey,
        attemptsAtFind: this.attempts,
      };
      this.found.push(key);
      this.emit('found', key);
      if (this.found.length >= this.count) this.shutdown('done');
    }
  }

  elapsedMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  /** Attempts/sec over the last ~5s (falls back to the whole run). */
  rate(): number {
    const overall = this.attempts / Math.max(this.elapsedMs() / 1000, 0.001);
    if (this.window.length < 2) return overall;
    const span = (Date.now() - this.window[0].t) / 1000;
    if (span < 0.25) return overall;
    const n = this.window.reduce((sum, e) => sum + e.n, 0);
    return n / span;
  }

  stop(): void {
    this.shutdown('stopped');
  }

  private shutdown(event: 'done' | 'stopped'): void {
    if (!this.running) return;
    this.running = false;
    for (const w of this.workers) {
      w.postMessage('stop');
      void w.terminate();
    }
    this.workers = [];
    this.emit(event);
  }
}
