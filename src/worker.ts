import { parentPort, workerData } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildMatcher, type Criteria } from './pattern.js';

if (!parentPort) throw new Error('worker.js must be run as a worker thread');
const port = parentPort;

// Self-check: noble's ed25519 derivation must agree with tweetnacl's
// independent implementation before we trust it to grind keys.
{
  const seed = randomBytes(32);
  const noblePub = ed25519.getPublicKey(seed);
  const naclPub = nacl.sign.keyPair.fromSeed(seed).publicKey;
  if (Buffer.compare(Buffer.from(noblePub), Buffer.from(naclPub)) !== 0) {
    throw new Error('ed25519 self-check failed: noble and tweetnacl disagree');
  }
}

const criteria = workerData as Criteria;
const matches = buildMatcher(criteria);
const BATCH = 500;

let stopped = false;
port.on('message', (msg) => {
  if (msg === 'stop') stopped = true;
});

function grindEvm(): void {
  if (stopped) return;
  for (let i = 0; i < BATCH; i++) {
    // fresh CSPRNG key every attempt — never seeded, never incremented
    const privateKey = generatePrivateKey();
    const address = privateKeyToAddress(privateKey);
    if (matches(address)) port.postMessage({ type: 'found', address, privateKey });
  }
  port.postMessage({ type: 'progress', attempts: BATCH });
  setImmediate(grindEvm); // yield so 'stop' messages get processed
}

function grindSol(): void {
  if (stopped) return;
  for (let i = 0; i < BATCH; i++) {
    // fresh 32-byte seed from the OS CSPRNG every attempt — never a PRNG.
    // ed25519 via @noble/curves is the same primitive @solana/web3.js
    // Keypair.generate() uses; tweetnacl cross-checks it at startup above.
    const seed = randomBytes(32);
    const publicKey = ed25519.getPublicKey(seed);
    const address = bs58.encode(publicKey);
    if (matches(address)) {
      const secretKey = new Uint8Array(64); // solana secret = seed || pubkey
      secretKey.set(seed, 0);
      secretKey.set(publicKey, 32);
      port.postMessage({
        type: 'found',
        address,
        privateKey: bs58.encode(secretKey), // 64-byte secret, Phantom import format
        privateKeyJson: JSON.stringify(Array.from(secretKey)), // solana-cli id.json format
      });
    }
  }
  port.postMessage({ type: 'progress', attempts: BATCH });
  setImmediate(grindSol);
}

(criteria.chain === 'sol' ? grindSol : grindEvm)();
