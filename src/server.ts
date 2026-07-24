import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import {
  UsageError,
  describeCriteria,
  expectedAttempts,
  validateCriteria,
  type Chain,
  type Criteria,
  type Mode,
} from './pattern.js';
import { measureSingleThreadRate, projectedRate } from './estimate.js';
import { VanityEngine, type FoundKey } from './engine.js';
import { writeKeyFile } from './save.js';
import { loadCachedRate, saveCachedRate } from './rate-cache.js';

const HOST = '127.0.0.1'; // localhost ONLY — never bind 0.0.0.0
const PORT = 3939;
const WORKERS = availableParallelism();
const CHAINS: Chain[] = ['evm', 'sol'];

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url));

let engine: VanityEngine | null = null;
let lastCriteria: Criteria | null = null;
let lastResult: FoundKey | null = null;

const baseRate: Record<Chain, number> = { evm: 0, sol: 0 };
const observedRate: Record<Chain, number> = { evm: 0, sol: 0 };

for (const ch of CHAINS) {
  const cached = loadCachedRate(ch);
  if (cached) {
    baseRate[ch] = cached;
    console.log(`${ch} rate: ~${Math.round(cached).toLocaleString('en-US')} addr/s (cached from last measured run)`);
  } else {
    process.stdout.write(`measuring ${ch} rate... `);
    baseRate[ch] = projectedRate(measureSingleThreadRate(ch, 300), WORKERS);
    console.log(`~${Math.round(baseRate[ch]).toLocaleString('en-US')} addr/s projected (${WORKERS} workers)`);
  }
}

const clients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15_000);

function currentRate(chain: Chain): number {
  return observedRate[chain] > 0 ? observedRate[chain] : baseRate[chain];
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10_000) {
        reject(new UsageError('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new UsageError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseChain(value: unknown): Chain {
  return value === 'sol' ? 'sol' : 'evm';
}

function startJob(body: Record<string, unknown>): { expected: number } {
  if (engine?.running) throw new UsageError('A job is already running — stop it first.');
  const criteria = validateCriteria({
    chain: parseChain(body.chain),
    mode: body.mode as Mode,
    pattern: String(body.pattern ?? ''),
    checksum: body.checksum === true,
    ignoreCase: body.ignoreCase === true,
  });
  const expected = expectedAttempts(criteria);
  const job = new VanityEngine(criteria, { workers: WORKERS, count: 1 });
  engine = job;
  lastCriteria = criteria;

  const progress = setInterval(() => {
    if (job.attempts > 2000) observedRate[criteria.chain] = job.rate();
    broadcast('progress', {
      chain: criteria.chain,
      attempts: job.attempts,
      rate: job.rate(),
      elapsedMs: job.elapsedMs(),
      expected,
    });
  }, 400);
  const cleanup = () => clearInterval(progress);

  job.on('found', (key: FoundKey) => {
    lastResult = key;
    // goes only to SSE clients on 127.0.0.1 — never logged server-side
    broadcast('found', {
      chain: criteria.chain,
      address: key.address,
      privateKey: key.privateKey,
      privateKeyJson: key.privateKeyJson,
      attempts: key.attemptsAtFind,
      elapsedMs: job.elapsedMs(),
    });
  });
  job.on('done', () => {
    cleanup();
    if (job.elapsedMs() > 3000 && job.attempts > 20_000) saveCachedRate(criteria.chain, job.rate());
    broadcast('done', { attempts: job.attempts, elapsedMs: job.elapsedMs() });
  });
  job.on('stopped', () => {
    cleanup();
    broadcast('stopped', { attempts: job.attempts });
  });
  job.on('error', (err) => {
    console.error('worker error:', err instanceof Error ? err.message : err);
  });

  job.start();
  broadcast('started', { chain: criteria.chain, expected, description: describeCriteria(criteria) });
  return { expected };
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? '';
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
    json(res, 403, { error: 'Forbidden' }); // DNS-rebinding guard
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
    } else if (req.method === 'GET' && url.pathname === '/api/estimate') {
      const chain = parseChain(url.searchParams.get('chain'));
      const criteria = validateCriteria({
        chain,
        mode: (url.searchParams.get('mode') ?? 'prefix') as Mode,
        pattern: url.searchParams.get('pattern') ?? '',
        checksum: url.searchParams.get('checksum') === '1',
        ignoreCase: url.searchParams.get('ignoreCase') === '1',
      });
      const expected = expectedAttempts(criteria);
      const rate = currentRate(chain);
      json(res, 200, { expected, rate, seconds: expected / rate, description: describeCriteria(criteria) });
    } else if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      if (engine?.running && lastCriteria) {
        res.write(
          `event: started\ndata: ${JSON.stringify({
            chain: lastCriteria.chain,
            expected: expectedAttempts(lastCriteria),
            description: describeCriteria(lastCriteria),
          })}\n\n`
        );
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = (await readBody(req)) as Record<string, unknown>;
      json(res, 200, startJob(body));
    } else if (req.method === 'POST' && url.pathname === '/api/stop') {
      engine?.stop();
      json(res, 200, { ok: true });
    } else if (req.method === 'POST' && url.pathname === '/api/save') {
      if (!lastResult || !lastCriteria) {
        json(res, 404, { error: 'Nothing to save yet.' });
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const path = writeKeyFile(resolve(process.cwd(), `vanity-keys-${stamp}.txt`), lastCriteria, [lastResult]);
        console.log(`saved keys (plaintext!) to ${path}`);
        json(res, 200, { path });
      }
    } else {
      json(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    if (err instanceof UsageError) {
      json(res, 400, { error: err.message });
    } else {
      console.error(err);
      json(res, 500, { error: 'Internal error' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  vanity web UI (EVM + SOL)  ->  http://${HOST}:${PORT}`);
  console.log('');
  console.log(`  bound to ${HOST} ONLY — not reachable from your network`);
  console.log('  keys are never logged and never written unless you click save');
});
