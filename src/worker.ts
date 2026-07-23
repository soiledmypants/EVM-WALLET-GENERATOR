import { parentPort, workerData } from 'node:worker_threads';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { buildMatcher, type Criteria } from './pattern.js';

if (!parentPort) throw new Error('worker.js must be run as a worker thread');
const port = parentPort;

const criteria = workerData as Criteria;
const matches = buildMatcher(criteria);
const BATCH = 500;

let stopped = false;
port.on('message', (msg) => {
  if (msg === 'stop') stopped = true;
});

function grind(): void {
  if (stopped) return;
  for (let i = 0; i < BATCH; i++) {
    // fresh CSPRNG key every attempt — never seeded, never incremented
    const privateKey = generatePrivateKey();
    const address = privateKeyToAddress(privateKey);
    if (matches(address)) port.postMessage({ type: 'found', address, privateKey });
  }
  port.postMessage({ type: 'progress', attempts: BATCH });
  setImmediate(grind); // yield so 'stop' messages get processed
}
grind();
