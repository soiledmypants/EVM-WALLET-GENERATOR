#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { availableParallelism } from 'node:os';
import {
  UsageError,
  describeCriteria,
  expectedAttempts,
  validateCriteria,
  type Chain,
  type Criteria,
  type Mode,
} from './pattern.js';
import { formatDuration, formatInt, measureSingleThreadRate, projectedRate } from './estimate.js';
import { VanityEngine, type FoundKey } from './engine.js';
import { writeKeyFile } from './save.js';
import { loadCachedRate, saveCachedRate } from './rate-cache.js';
import { createSolKeygen } from './sol-keygen.js';

const CORES = availableParallelism();

const HELP = `vanity-evm — local vanity address generator for EVM + Solana (CSPRNG only, no network)

USAGE
  vanity-evm [evm] --prefix <hex>       EVM: address starts with 0x<hex>
  vanity-evm sol --prefix <base58>      Solana: address starts with <base58>
  vanity-evm [evm|sol] --suffix <pat>   address ends with <pat>
  vanity-evm [evm|sol] --contains <pat> address contains <pat> anywhere
  vanity-evm [evm|sol] --benchmark      measure this machine's addresses/sec

  The chain defaults to evm, so all pre-existing EVM invocations work as-is.

OPTIONS
  --checksum       evm only: case-sensitive EIP-55 match — letter casing must
                   match your pattern exactly. ~2x harder per a-f letter.
  --ignore-case    sol only: match any capitalization. Solana addresses are
                   case-sensitive, so this is much faster for word patterns.
  --count <n>      keep going until n matches are found (default 1)
  --workers <n>    worker threads (default: all ${CORES} cores)
  --save <file>    ALSO write results to <file> in plaintext (loud warning)
  -h, --help       this text

PATTERN CHARSETS
  evm  hex: 0-9 a-f. Lookalikes: o→0, i/l→1, z→2, s→5, g→9, t→7.
  sol  base58: 1-9, A-H J-N P-Z, a-k m-z. Excluded lookalikes: 0→o, O→o,
       I→i, l→L/1. Case-sensitive unless --ignore-case.

EXAMPLES
  vanity-evm --prefix c0ffee
  vanity-evm evm --prefix AbCd --checksum
  vanity-evm sol --prefix kumo --ignore-case
  vanity-evm sol --suffix moon --count 2
  vanity-evm sol --benchmark
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        prefix: { type: 'string' },
        suffix: { type: 'string' },
        contains: { type: 'string' },
        checksum: { type: 'boolean', default: false },
        'ignore-case': { type: 'boolean', default: false },
        count: { type: 'string', default: '1' },
        workers: { type: 'string' },
        save: { type: 'string' },
        benchmark: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : err}\nRun with --help for usage.`);
  }
}

const { values, positionals } = parseCliArgs();

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const chain: Chain = (() => {
  if (positionals.length === 0) return 'evm';
  const [sub] = positionals;
  if (positionals.length === 1 && (sub === 'evm' || sub === 'sol')) return sub;
  fail(`Unknown argument(s): ${positionals.join(' ')} — expected an "evm" or "sol" subcommand. See --help.`);
})();

if (chain === 'evm' && values['ignore-case']) {
  fail('--ignore-case applies to sol only. EVM matching is already case-insensitive; use --checksum for exact EIP-55 casing.');
}
if (chain === 'sol' && values.checksum) {
  fail('--checksum applies to evm only. Solana addresses are case-sensitive by default; use --ignore-case to relax that.');
}

const workers = (() => {
  if (values.workers === undefined) return CORES;
  const n = Number.parseInt(values.workers, 10);
  if (!Number.isInteger(n) || n < 1 || n > 256) fail('--workers must be an integer between 1 and 256');
  return n;
})();

if (values.benchmark) {
  runBenchmark(chain, workers);
} else {
  runSearch();
}

function runSearch(): void {
  const picked: Array<[Mode, string]> = [];
  if (values.prefix !== undefined) picked.push(['prefix', values.prefix]);
  if (values.suffix !== undefined) picked.push(['suffix', values.suffix]);
  if (values.contains !== undefined) picked.push(['contains', values.contains]);
  if (picked.length !== 1) {
    fail('Pass exactly one of --prefix, --suffix, --contains (or --benchmark). See --help.');
  }

  const count = Number.parseInt(values.count ?? '1', 10);
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive integer');

  let criteria: Criteria;
  try {
    criteria = validateCriteria({
      chain,
      mode: picked[0][0],
      pattern: picked[0][1],
      checksum: values.checksum ?? false,
      ignoreCase: values['ignore-case'] ?? false,
    });
  } catch (err) {
    if (err instanceof UsageError) fail(err.message);
    throw err;
  }

  const expectedPer = expectedAttempts(criteria);
  const expectedTotal = expectedPer * count;

  console.log(`pattern:            ${describeCriteria(criteria)}`);
  console.log(
    `expected attempts:  ${formatInt(expectedPer)} per match (50% chance within ${formatInt(expectedPer * 0.693)})`
  );
  process.stdout.write('measuring machine:  ');
  const cached = loadCachedRate(chain);
  const projected = cached ?? projectedRate(measureSingleThreadRate(chain), workers);
  console.log(
    cached
      ? `~${formatInt(cached)} addr/s (cached from last measured ${chain} run)`
      : `~${formatInt(projected)} addr/s (rough projection — run ${chain === 'sol' ? 'sol ' : ''}--benchmark for a real number)`
  );
  console.log(
    `estimated time:     ~${formatDuration(expectedTotal / projected)}${count > 1 ? ` for ${count} matches` : ''}`
  );
  console.log('');

  const engine = new VanityEngine(criteria, { workers, count });
  const results: FoundKey[] = [];
  const isTTY = process.stderr.isTTY === true;

  const status = setInterval(
    () => {
      const rate = engine.rate();
      const likely = (1 - Math.exp(-engine.attempts / expectedPer)) * 100;
      const line =
        `${formatInt(engine.attempts)} attempts | ${formatInt(rate)} addr/s | ` +
        `${formatDuration(engine.elapsedMs() / 1000)} elapsed | ` +
        `${likely.toFixed(likely > 99.4 ? 1 : 0)}% chance found by now`;
      if (isTTY) process.stderr.write(`\r\x1b[2K  ${line}`);
      else console.error(`  [${new Date().toISOString().slice(11, 19)}] ${line}`);
    },
    isTTY ? 500 : 10_000
  );

  engine.on('error', (err) => {
    if (isTTY) process.stderr.write('\r\x1b[2K');
    console.error(`worker error: ${err instanceof Error ? err.message : err}`);
  });

  engine.on('found', (key: FoundKey) => {
    results.push(key);
    if (isTTY) process.stderr.write('\r\x1b[2K');
    console.log(
      `match ${results.length}/${count} after ${formatInt(engine.attempts)} attempts (${formatDuration(engine.elapsedMs() / 1000)})`
    );
    console.log(`  address:     ${key.address}`);
    if (key.privateKeyJson) {
      console.log(`  private key (base58 — import into Phantom):`);
      console.log(`    ${key.privateKey}`);
      console.log(`  private key (JSON byte array — solana-cli id.json):`);
      console.log(`    ${key.privateKeyJson}`);
    } else {
      console.log(`  private key: ${key.privateKey}`);
    }
    console.log('');
  });

  engine.on('done', () => {
    clearInterval(status);
    const seconds = Math.max(engine.elapsedMs() / 1000, 0.001);
    if (seconds > 3 && engine.attempts > 20_000) saveCachedRate(chain, engine.rate());
    console.log(
      `done: ${results.length} match${results.length === 1 ? '' : 'es'} in ${formatInt(engine.attempts)} attempts, ` +
        `${formatDuration(seconds)} (~${formatInt(engine.attempts / seconds)} addr/s)`
    );
    console.log('');
    console.log('KEEP PRIVATE KEYS SECRET — anyone who has one controls that wallet.');
    console.log('Send a small test amount first before using a wallet for real funds.');
    finishSave();
    process.exit(0);
  });

  engine.on('stopped', () => {
    clearInterval(status);
    console.log(
      `\nstopped after ${formatInt(engine.attempts)} attempts — ${results.length} match${results.length === 1 ? '' : 'es'} found`
    );
    finishSave();
    process.exit(130);
  });

  function finishSave(): void {
    if (!values.save || results.length === 0) return;
    const path = writeKeyFile(values.save, criteria, results);
    const bar = '#'.repeat(74);
    console.log('');
    console.log(bar);
    console.log('#  WARNING: PRIVATE KEYS WRITTEN IN PLAINTEXT TO:');
    console.log(`#    ${path}`);
    console.log('#  Anyone who can read this file controls these wallets.');
    console.log('#  Import the keys into a proper wallet, then DELETE this file.');
    console.log(bar);
  }

  process.on('SIGINT', () => engine.stop());
  engine.start();
}

function runBenchmark(benchChain: Chain, workerCount: number): void {
  console.log(`benchmark: ${benchChain}, ${workerCount} workers, 5 seconds...`);
  if (benchChain === 'sol') {
    const { keygen, measured } = createSolKeygen(100);
    const detail = Object.entries(measured)
      .map(([name, rate]) => `${name} ${formatInt(rate)}/s`)
      .join(', ');
    console.log(`keygen:    ${keygen.name} (single-thread: ${detail})`);
  }
  // patterns chosen to be astronomically unlikely to match during a benchmark
  const criteria: Criteria =
    benchChain === 'sol'
      ? { chain: 'sol', mode: 'prefix', pattern: 'zzzzzzzzzz', checksum: false, ignoreCase: false }
      : { chain: 'evm', mode: 'prefix', pattern: 'ffffffffffff', checksum: false, ignoreCase: false };
  const engine = new VanityEngine(criteria, { workers: workerCount, count: 1 });
  engine.on('error', () => {});
  const isTTY = process.stderr.isTTY === true;
  const status = setInterval(() => {
    if (isTTY) {
      process.stderr.write(`\r\x1b[2K  ${formatInt(engine.attempts)} attempts | ${formatInt(engine.rate())} addr/s`);
    }
  }, 500);
  engine.start();
  setTimeout(() => {
    clearInterval(status);
    const seconds = Math.max(engine.elapsedMs() / 1000, 0.001);
    // rate() uses the trailing window, so worker-startup dead time is excluded
    const rate = engine.rate();
    engine.stop();
    saveCachedRate(benchChain, rate);
    if (isTTY) process.stderr.write('\r\x1b[2K');
    console.log(`chain:     ${benchChain}`);
    console.log(`workers:   ${workerCount}`);
    console.log(`attempts:  ${formatInt(engine.attempts)} in ${seconds.toFixed(1)}s (incl. worker startup)`);
    console.log(`rate:      ${formatInt(rate)} addresses/sec (steady-state, cached for future estimates)`);
    console.log('');
    if (benchChain === 'sol') {
      console.log('expected time for a case-sensitive base58 prefix at this rate:');
      for (const len of [3, 4, 5, 6, 7, 8]) {
        const expected = 58 ** len;
        console.log(
          `  ${String(len).padStart(2)} chars  ${formatInt(expected).padStart(20)} attempts  ~${formatDuration(expected / rate)}`
        );
      }
      console.log('(--ignore-case cuts this roughly in half per letter; prefix odds also');
      console.log(' depend on the first character — only 2-J can start a 44-char address)');
    } else {
      console.log('expected time for a plain hex prefix at this rate:');
      for (const len of [4, 5, 6, 7, 8, 10]) {
        const expected = 16 ** len;
        console.log(
          `  ${String(len).padStart(2)} chars  ${formatInt(expected).padStart(20)} attempts  ~${formatDuration(expected / rate)}`
        );
      }
    }
    process.exit(0);
  }, 5000);
}
