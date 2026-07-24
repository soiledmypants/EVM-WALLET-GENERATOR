import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeCriteria, type Criteria } from './pattern.js';
import type { FoundKey } from './engine.js';

/** Writes results to a plaintext file. Caller is responsible for the loud warning. */
export function writeKeyFile(file: string, criteria: Criteria, results: FoundKey[]): string {
  const path = resolve(file);
  const lines = [
    '!!! PRIVATE KEY MATERIAL — anyone with these keys controls the wallets !!!',
    '!!! Keep offline. Never share. Never commit to git. Delete when done.  !!!',
    '',
    `generated: ${new Date().toISOString()}`,
    `pattern:   ${describeCriteria(criteria)}`,
    '',
  ];
  results.forEach((r, i) => {
    lines.push(`# match ${i + 1}`, `address:     ${r.address}`);
    if (r.privateKeyJson) {
      lines.push(
        `private key (base58 — import into Phantom):          ${r.privateKey}`,
        `private key (JSON byte array — solana-cli id.json):  ${r.privateKeyJson}`
      );
    } else {
      lines.push(`private key: ${r.privateKey}`);
    }
    lines.push('');
  });
  lines.push(
    'Reminder: send a small test amount and confirm you can move it back out',
    'before using this wallet for anything real.'
  );
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
  return path;
}
