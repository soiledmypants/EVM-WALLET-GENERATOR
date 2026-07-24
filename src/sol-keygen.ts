import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';

/**
 * Native ed25519 keypair generation for the sol hot loop. Two candidates:
 *  - sodium-native: libsodium's crypto_sign_keypair into preallocated buffers
 *    (seed drawn internally from libsodium's OS-CSPRNG randombytes)
 *  - node crypto.generateKeyPairSync('ed25519'): OpenSSL-native (seeded by the
 *    OS CSPRNG via OpenSSL RAND); raw key bytes sliced out of the DER exports
 * Whichever measures faster on this machine wins at runtime. Only the keygen
 * library is selectable — the randomness source is the OS CSPRNG either way.
 */
export interface SolKeygen {
  name: 'sodium-native' | 'node-crypto';
  /** Fills pk (32 bytes) and sk (64 bytes, seed||pubkey) in place. */
  generate(pk: Buffer, sk: Buffer): void;
}

interface SodiumLike {
  crypto_sign_PUBLICKEYBYTES: number;
  crypto_sign_SECRETKEYBYTES: number;
  crypto_sign_keypair(pk: Buffer, sk: Buffer): void;
}

function sodiumKeygen(): SolKeygen | null {
  try {
    const require = createRequire(import.meta.url);
    const sodium = require('sodium-native') as SodiumLike;
    const pk = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
    const sk = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
    sodium.crypto_sign_keypair(pk, sk); // smoke test before trusting it
    if (pk.length !== 32 || sk.length !== 64) return null;
    return {
      name: 'sodium-native',
      generate: (p, s) => sodium.crypto_sign_keypair(p, s),
    };
  } catch {
    return null;
  }
}

function nodeCryptoKeygen(): SolKeygen {
  return {
    name: 'node-crypto',
    generate: (pk, sk) => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      // ed25519 SPKI DER is a 12-byte header + 32 raw pubkey bytes;
      // PKCS8 DER is a 16-byte header + 32 raw seed bytes
      const spki = publicKey.export({ type: 'spki', format: 'der' });
      const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
      spki.copy(pk, 0, spki.length - 32);
      pkcs8.copy(sk, 0, pkcs8.length - 32);
      pk.copy(sk, 32);
    },
  };
}

function measure(kg: SolKeygen, ms: number): number {
  const pk = Buffer.alloc(32);
  const sk = Buffer.alloc(64);
  for (let i = 0; i < 50; i++) kg.generate(pk, sk);
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < ms) {
    for (let i = 0; i < 100; i++) kg.generate(pk, sk);
    n += 100;
  }
  return n / ((performance.now() - start) / 1000);
}

/** Benchmarks the available implementations and returns the fastest. */
export function createSolKeygen(benchMs = 60): { keygen: SolKeygen; measured: Record<string, number> } {
  const candidates: SolKeygen[] = [];
  const sodium = sodiumKeygen();
  if (sodium) candidates.push(sodium);
  candidates.push(nodeCryptoKeygen());

  let best = candidates[0];
  let bestRate = -1;
  const measured: Record<string, number> = {};
  for (const c of candidates) {
    const rate = measure(c, benchMs);
    measured[c.name] = Math.round(rate);
    if (rate > bestRate) {
      bestRate = rate;
      best = c;
    }
  }
  return { keygen: best, measured };
}
