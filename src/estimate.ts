import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import type { Chain } from './pattern.js';
import { createSolKeygen } from './sol-keygen.js';
import { B58_DIGITS_LEN, encode58Fixed } from './base58.js';

/** Measures single-thread key -> address derivations per second for a chain. */
export function measureSingleThreadRate(chain: Chain, ms = 300): number {
  let derive: () => void;
  if (chain === 'sol') {
    // same pipeline the sol worker runs: native keygen + fast base58
    const { keygen } = createSolKeygen(40);
    const pk = Buffer.alloc(32);
    const sk = Buffer.alloc(64);
    const digits = new Uint8Array(B58_DIGITS_LEN);
    derive = () => {
      keygen.generate(pk, sk);
      encode58Fixed(pk, digits);
    };
  } else {
    derive = () => {
      privateKeyToAddress(generatePrivateKey());
    };
  }
  // warmup: curve libraries build precompute tables on first use
  for (let i = 0; i < 30; i++) derive();
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < ms) {
    for (let i = 0; i < 20; i++) derive();
    n += 20;
  }
  return n / ((performance.now() - start) / 1000);
}

/** Rough multi-worker throughput projected from a single-thread measurement. */
export function projectedRate(singleThreadRate: number, workers: number): number {
  return singleThreadRate * workers * 0.9;
}

export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return 'infinity';
  if (n >= 1e15) return n.toExponential(2);
  return Math.round(n).toLocaleString('en-US');
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'forever';
  if (seconds < 1) return 'under a second';
  const units: Array<[string, number]> = [
    ['y', 31_536_000],
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts: string[] = [];
  let rest = Math.round(seconds);
  for (const [label, span] of units) {
    if (rest >= span) {
      parts.push(`${Math.floor(rest / span)}${label}`);
      rest %= span;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}
