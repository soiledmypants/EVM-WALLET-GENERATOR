export type Mode = 'prefix' | 'suffix' | 'contains';
export type Chain = 'evm' | 'sol';

export interface Criteria {
  chain: Chain;
  mode: Mode;
  pattern: string;
  /** EVM only: pattern letter casing must match the EIP-55 checksummed address exactly. */
  checksum: boolean;
  /** SOL only: match regardless of letter casing (Solana addresses are case-sensitive). */
  ignoreCase: boolean;
}

export class UsageError extends Error {}

const HEX_RE = /^[0-9a-fA-F]+$/;
export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_SET = new Set(BASE58_ALPHABET);
const EVM_ADDR_LEN = 40;
// typical mainnet address length (43-44 chars), used for "contains" position math
const SOL_ADDR_LEN = 44;

export function validateCriteria(input: Criteria): Criteria {
  const { chain, mode, checksum, ignoreCase } = input;
  if (chain !== 'evm' && chain !== 'sol') throw new UsageError('chain must be evm or sol');
  if (mode !== 'prefix' && mode !== 'suffix' && mode !== 'contains') {
    throw new UsageError('mode must be prefix, suffix, or contains');
  }
  const pattern = input.pattern.trim();
  if (!pattern) throw new UsageError('Pattern is empty.');

  if (chain === 'evm') {
    if (pattern.length > EVM_ADDR_LEN) {
      throw new UsageError('Pattern is longer than an address (40 hex characters).');
    }
    if (!HEX_RE.test(pattern)) {
      const bad = [...new Set([...pattern].filter((ch) => !/[0-9a-fA-F]/.test(ch)))];
      throw new UsageError(
        `Invalid character${bad.length > 1 ? 's' : ''} ${bad.map((b) => JSON.stringify(b)).join(', ')}: ` +
          'EVM addresses only contain 0-9 and a-f. Common lookalikes: o→0, i/l→1, z→2, s→5, g→9, t→7.'
      );
    }
    return { chain, mode, checksum, ignoreCase: false, pattern: checksum ? pattern : pattern.toLowerCase() };
  }

  if (pattern.length > SOL_ADDR_LEN) {
    throw new UsageError('Pattern is longer than a Solana address (~44 base58 characters).');
  }
  const bad: string[] = [];
  for (const ch of new Set(pattern)) {
    if (BASE58_SET.has(ch)) continue;
    // with --ignore-case a letter is fine if either casing exists in the alphabet
    if (ignoreCase && (BASE58_SET.has(ch.toLowerCase()) || BASE58_SET.has(ch.toUpperCase()))) continue;
    bad.push(ch);
  }
  if (bad.length > 0) {
    const hints: Record<string, string> = {
      '0': '"0" (zero) → use letter o',
      O: '"O" → use lowercase o',
      I: '"I" → use lowercase i',
      l: '"l" → use uppercase L or 1',
    };
    const hinted = bad.map((b) => hints[b] ?? JSON.stringify(b));
    throw new UsageError(
      `Invalid base58 character${bad.length > 1 ? 's' : ''}: ${hinted.join(', ')}. ` +
        'Base58 excludes 0, O, I and l to avoid lookalikes. Valid: 1-9, A-H J-N P-Z, a-k m-z.'
    );
  }
  return { chain, mode, checksum: false, ignoreCase, pattern };
}

/**
 * Returns a predicate over the address string:
 * EVM gets a checksummed "0xAbC..." address, SOL a base58 string.
 */
export function buildMatcher(c: Criteria): (address: string) => boolean {
  const p = c.pattern;
  if (c.chain === 'sol') {
    if (c.ignoreCase) {
      const q = p.toLowerCase();
      if (c.mode === 'prefix') return (a) => a.toLowerCase().startsWith(q);
      if (c.mode === 'suffix') return (a) => a.toLowerCase().endsWith(q);
      return (a) => a.toLowerCase().includes(q);
    }
    if (c.mode === 'prefix') return (a) => a.startsWith(p);
    if (c.mode === 'suffix') return (a) => a.endsWith(p);
    return (a) => a.includes(p);
  }
  if (c.checksum) {
    if (c.mode === 'prefix') return (a) => a.startsWith(p, 2);
    if (c.mode === 'suffix') return (a) => a.endsWith(p);
    return (a) => a.includes(p, 2);
  }
  if (c.mode === 'prefix') return (a) => a.toLowerCase().startsWith(p, 2);
  if (c.mode === 'suffix') return (a) => a.toLowerCase().endsWith(p);
  return (a) => a.toLowerCase().includes(p, 2);
}

// A 32-byte pubkey is a uniform 256-bit integer V. Base58 gives a 44-char
// address only when V >= 58^43, and its first char is then floor(V / 58^43),
// which can only be alphabet index 1..17 ('2'..'J') because
// 2^256 / 58^43 ≈ 17.22. Any char can start a (rarer, ~5.8%) 43-char address.
// So prefix odds depend heavily on the first character: a lowercase-led
// prefix like "kumo" is ~17x rarer than naive 58^-len math suggests.
const SOL_LEN_RATIO = 2 ** 256 / 58 ** 43; // ≈ 17.22

/** P(a random Solana address starts with the alphabet char at index idx). */
function solFirstCharProb(idx: number): number {
  const bucket = 1 / SOL_LEN_RATIO; // one full 44-char first-digit bucket ≈ 0.058
  let p = 0;
  if (idx >= 1 && idx < Math.floor(SOL_LEN_RATIO)) p += bucket; // full 44-char bucket
  if (idx === Math.floor(SOL_LEN_RATIO)) p += 1 - Math.floor(SOL_LEN_RATIO) / SOL_LEN_RATIO; // partial top bucket
  p += bucket / 58; // starting char of a 43-char address (any char possible)
  return p;
}

/** Alphabet chars a single pattern char can match, honoring ignoreCase. */
export function solCharMatches(ch: string, ignoreCase: boolean): string[] {
  if (!ignoreCase) return [ch];
  return [...new Set([ch.toLowerCase(), ch.toUpperCase()])].filter((v) => BASE58_SET.has(v));
}

/**
 * Cheap prefix pre-filter: which first PUBKEY BYTES can possibly produce an
 * address starting with one of `chars`. The first base58 char is decided by
 * the numeric range of the 256-bit pubkey (first char '1' iff byte0 == 0;
 * otherwise the leading digit of a 43/44-char encoding), so most candidates
 * can be rejected on byte0 alone, before any base58 encoding. Conservative:
 * boundary bytes are kept (false positives fall through to the full match),
 * never false negatives.
 */
export function buildFirstByteFilter(chars: string[]): Uint8Array {
  const allowed = new Uint8Array(256);
  const CAP = 1n << 256n;
  const P43 = 58n ** 42n; // scale of the leading digit of a 43-char address
  const P44 = 58n ** 43n; // scale of the leading digit of a 44-char address
  for (const ch of chars) {
    const idx = BigInt(BASE58_ALPHABET.indexOf(ch));
    if (idx < 0n) continue;
    if (idx === 0n) {
      // '1' prefix comes from a leading zero byte and nothing else
      allowed[0] = 1;
      continue;
    }
    for (const scale of [P43, P44]) {
      const lo = idx * scale;
      let hi = (idx + 1n) * scale; // value range [lo, hi)
      if (lo >= CAP) continue;
      if (hi > CAP) hi = CAP;
      const bLo = Number(lo >> 248n);
      const bHi = Number((hi - 1n) >> 248n);
      for (let b = bLo; b <= bHi; b++) allowed[b] = 1;
    }
  }
  return allowed;
}

/**
 * Expected (mean) number of random addresses tried before one match.
 * SOL prefix estimates model first-character reachability (see above);
 * remaining positions use the standard per-character math.
 */
export function expectedAttempts(c: Criteria): number {
  if (c.chain === 'sol') {
    let perPosition = 1;
    const chars = [...c.pattern];
    for (const ch of chars) {
      // most letters exist in both cases (2 of 58); digits and the
      // single-case letters o/i/L only match themselves (1 of 58)
      const variants = solCharMatches(ch, c.ignoreCase).length;
      perPosition *= 58 / Math.max(variants, 1);
    }
    if (c.mode === 'prefix') {
      const pFirst = solCharMatches(chars[0], c.ignoreCase)
        .map((v) => solFirstCharProb(BASE58_ALPHABET.indexOf(v)))
        .reduce((a, b) => a + b, 0);
      let rest = 1;
      for (const ch of chars.slice(1)) {
        rest *= 58 / Math.max(solCharMatches(ch, c.ignoreCase).length, 1);
      }
      return rest / Math.max(pFirst, Number.EPSILON);
    }
    if (c.mode === 'contains') {
      const positions = Math.max(SOL_ADDR_LEN - c.pattern.length + 1, 1);
      return perPosition / positions;
    }
    return perPosition;
  }

  const len = c.pattern.length;
  let perPosition = 16 ** len;
  if (c.checksum) {
    // each a-f letter must also land on the right EIP-55 case: ~2x per letter
    const letters = (c.pattern.match(/[a-f]/gi) ?? []).length;
    perPosition *= 2 ** letters;
  }
  if (c.mode === 'contains') {
    const positions = EVM_ADDR_LEN - len + 1;
    return perPosition / positions;
  }
  return perPosition;
}

export function describeCriteria(c: Criteria): string {
  const flag =
    c.chain === 'evm'
      ? c.checksum
        ? ' (EIP-55 checksum-exact)'
        : ''
      : c.ignoreCase
        ? ' (ignore case)'
        : ' (case-sensitive)';
  return `${c.chain} ${c.mode} "${c.pattern}"${flag}`;
}
