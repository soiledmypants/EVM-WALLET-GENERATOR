import { readFileSync, writeFileSync } from 'node:fs';
import type { Chain } from './pattern.js';

// Measured aggregate rate per chain from a real run/benchmark, cached so
// difficulty estimates reflect this machine instead of a rough projection.
// ed25519 (sol) and secp256k1 (evm) run at very different speeds, so the
// rates are stored under per-chain keys.
const CACHE_URL = new URL('../.machine-rate.json', import.meta.url);

interface CacheEntry {
  rate?: number;
  measuredAt?: string;
}

function readCache(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CACHE_URL, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadCachedRate(chain: Chain): number | null {
  const data = readCache();
  const entry = data[chain] as CacheEntry | undefined;
  if (entry && typeof entry.rate === 'number' && entry.rate > 0) return entry.rate;
  // legacy single-rate format predates sol support and was EVM-only
  if (chain === 'evm' && typeof data.rate === 'number' && data.rate > 0) return data.rate;
  return null;
}

export function saveCachedRate(chain: Chain, rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const data = readCache();
  delete data.rate;
  delete data.measuredAt;
  data[chain] = { rate: Math.round(rate), measuredAt: new Date().toISOString() };
  try {
    writeFileSync(CACHE_URL, JSON.stringify(data));
  } catch {
    // cache is best-effort
  }
}
