import { readFileSync, writeFileSync } from 'node:fs';

// Measured aggregate rate from a real run/benchmark, cached so difficulty
// estimates reflect this machine instead of a rough single-thread projection.
const CACHE_URL = new URL('../.machine-rate.json', import.meta.url);

export function loadCachedRate(): number | null {
  try {
    const data = JSON.parse(readFileSync(CACHE_URL, 'utf8')) as { rate?: number };
    return typeof data.rate === 'number' && data.rate > 0 ? data.rate : null;
  } catch {
    return null;
  }
}

export function saveCachedRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  try {
    writeFileSync(CACHE_URL, JSON.stringify({ rate: Math.round(rate), measuredAt: new Date().toISOString() }));
  } catch {
    // cache is best-effort
  }
}
