import { parentPort, workerData } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildFirstByteFilter, buildMatcher, solCharMatches, type Criteria } from './pattern.js';
import { createSolKeygen } from './sol-keygen.js';
import { B58_DIGITS_LEN, encode58Fixed } from './base58.js';

if (!parentPort) throw new Error('worker.js must be run as a worker thread');
const port = parentPort;

const criteria = workerData as Criteria;
const matches = buildMatcher(criteria);

let stopped = false;
port.on('message', (msg) => {
  if (msg === 'stop') stopped = true;
});

function grindEvm(): void {
  const BATCH = 500;
  const loop = (): void => {
    if (stopped) return;
    for (let i = 0; i < BATCH; i++) {
      // fresh CSPRNG key every attempt — never seeded, never incremented
      const privateKey = generatePrivateKey();
      const address = privateKeyToAddress(privateKey);
      if (matches(address)) port.postMessage({ type: 'found', address, privateKey });
    }
    port.postMessage({ type: 'progress', attempts: BATCH });
    setImmediate(loop); // yield so 'stop' messages get processed
  };
  loop();
}

function grindSol(): void {
  // native keygen (sodium-native libsodium, or OpenSSL via node crypto),
  // fastest implementation picked by a runtime benchmark. Randomness is the
  // OS CSPRNG in both. Buffers are preallocated once and reused — the hot
  // loop performs no allocations until a candidate survives the pre-filter.
  const { keygen } = createSolKeygen();
  const pk = Buffer.alloc(32);
  const sk = Buffer.alloc(64);
  const digits = new Uint8Array(B58_DIGITS_LEN);

  // Self-check 1: fast encoder must agree with bs58 (random + leading-zero edge cases)
  for (let i = 0; i < 200; i++) {
    const sample = randomBytes(32);
    if (i % 4 === 0) sample.fill(0, 0, 1 + (i % 8)); // exercise leading zeros
    if (encode58Fixed(sample, digits) !== bs58.encode(sample)) {
      throw new Error('base58 self-check failed: fast encoder and bs58 disagree');
    }
  }
  // Self-check 2: keygen output must agree with two independent ed25519
  // implementations deriving the pubkey back from the seed
  keygen.generate(pk, sk);
  const seed = sk.subarray(0, 32);
  const noblePub = Buffer.from(ed25519.getPublicKey(seed));
  const naclPub = Buffer.from(nacl.sign.keyPair.fromSeed(seed).publicKey);
  if (Buffer.compare(noblePub, pk) !== 0 || Buffer.compare(naclPub, pk) !== 0) {
    throw new Error(`ed25519 self-check failed: ${keygen.name} disagrees with noble/tweetnacl`);
  }

  // prefix mode: reject most candidates on the first pubkey byte, before encoding
  const firstByte =
    criteria.mode === 'prefix'
      ? buildFirstByteFilter(solCharMatches(criteria.pattern[0], criteria.ignoreCase))
      : null;

  const BATCH = 5000;
  const loop = (): void => {
    if (stopped) return;
    for (let i = 0; i < BATCH; i++) {
      keygen.generate(pk, sk);
      if (firstByte !== null && firstByte[pk[0]] === 0) continue;
      const address = encode58Fixed(pk, digits);
      if (matches(address)) {
        // verify before reporting: independently re-derive the pubkey from
        // the seed and confirm it encodes to the found address
        const check = Buffer.from(ed25519.getPublicKey(sk.subarray(0, 32)));
        if (Buffer.compare(check, pk) !== 0 || bs58.encode(check) !== address) {
          throw new Error('found-key verification failed: secret does not derive the found address');
        }
        const secretKey = Buffer.from(sk); // copy — sk is reused next iteration
        port.postMessage({
          type: 'found',
          address,
          privateKey: bs58.encode(secretKey), // 64-byte secret, Phantom import format
          privateKeyJson: JSON.stringify(Array.from(secretKey)), // solana-cli id.json format
        });
      }
    }
    port.postMessage({ type: 'progress', attempts: BATCH });
    setImmediate(loop);
  };
  loop();
}

if (criteria.chain === 'sol') grindSol();
else grindEvm();
