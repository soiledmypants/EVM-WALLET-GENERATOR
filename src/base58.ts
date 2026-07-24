import { BASE58_ALPHABET } from './pattern.js';

/**
 * Fast base58 for fixed 32-byte inputs (long division on small ints — no
 * BigInt, no per-call allocations). `digits` is a caller-owned scratch
 * Uint8Array(44) reused across calls. Cross-checked against bs58 at worker
 * startup before any results are trusted.
 */
export const B58_DIGITS_LEN = 44; // ceil(32 * log(256) / log(58)) = 44

export function encode58Fixed(buf: Uint8Array, digits: Uint8Array): string {
  let digitCount = 1;
  digits[0] = 0;
  for (let i = 0; i < 32; i++) {
    let carry = buf[i];
    for (let j = 0; j < digitCount; j++) {
      carry += digits[j] * 256; // max 57*256+255 < 2^15, stays a small int
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits[digitCount++] = carry % 58;
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  while (zeros < 32 && buf[zeros] === 0) zeros++;
  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  if (!(digitCount === 1 && digits[0] === 0)) {
    for (let i = digitCount - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}
