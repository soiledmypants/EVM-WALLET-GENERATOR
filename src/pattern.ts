export type Mode = 'prefix' | 'suffix' | 'contains';

export interface Criteria {
  mode: Mode;
  pattern: string;
  checksum: boolean;
}

export class UsageError extends Error {}

const HEX_RE = /^[0-9a-fA-F]+$/;

export function validateCriteria(input: Criteria): Criteria {
  const { mode, checksum } = input;
  if (mode !== 'prefix' && mode !== 'suffix' && mode !== 'contains') {
    throw new UsageError('mode must be prefix, suffix, or contains');
  }
  const pattern = input.pattern.trim();
  if (!pattern) throw new UsageError('Pattern is empty.');
  if (pattern.length > 40) {
    throw new UsageError('Pattern is longer than an address (40 hex characters).');
  }
  if (!HEX_RE.test(pattern)) {
    const bad = [...new Set([...pattern].filter((ch) => !/[0-9a-fA-F]/.test(ch)))];
    throw new UsageError(
      `Invalid character${bad.length > 1 ? 's' : ''} ${bad.map((b) => JSON.stringify(b)).join(', ')}: ` +
        'EVM addresses only contain 0-9 and a-f. Common lookalikes: o→0, i/l→1, z→2, s→5, g→9, t→7.'
    );
  }
  return { mode, checksum, pattern: checksum ? pattern : pattern.toLowerCase() };
}

/** Returns a predicate over a checksummed (EIP-55) address like "0xAbC...". */
export function buildMatcher(c: Criteria): (address: string) => boolean {
  const p = c.pattern;
  if (c.checksum) {
    if (c.mode === 'prefix') return (a) => a.startsWith(p, 2);
    if (c.mode === 'suffix') return (a) => a.endsWith(p);
    return (a) => a.includes(p, 2);
  }
  if (c.mode === 'prefix') return (a) => a.toLowerCase().startsWith(p, 2);
  if (c.mode === 'suffix') return (a) => a.toLowerCase().endsWith(p);
  return (a) => a.toLowerCase().includes(p, 2);
}

/** Expected (mean) number of random addresses tried before one match. */
export function expectedAttempts(c: Criteria): number {
  const len = c.pattern.length;
  let perPosition = 16 ** len;
  if (c.checksum) {
    // each a-f letter must also land on the right EIP-55 case: ~2x per letter
    const letters = (c.pattern.match(/[a-f]/gi) ?? []).length;
    perPosition *= 2 ** letters;
  }
  if (c.mode === 'contains') {
    const positions = 40 - len + 1;
    return perPosition / positions;
  }
  return perPosition;
}

export function describeCriteria(c: Criteria): string {
  return `${c.mode} "${c.pattern}"${c.checksum ? ' (EIP-55 checksum-exact)' : ''}`;
}
