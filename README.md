# vanity-evm

Local vanity address generator for **EVM** and **Solana**. Brute-forces random
keypairs across all your CPU cores until the address matches your pattern, then
prints the address and private key **to your terminal only**. Ships a CLI and a
localhost-only web UI. **Nothing ever leaves your machine — the tool makes zero
network calls.**

```
pattern:            sol prefix "kumo" (ignore case)
expected attempts:  24,372,336 per match (50% chance within 16,890,029)
measuring machine:  ~763,254 addr/s (cached from last measured sol run)
estimated time:     ~32s

match 1/1 after 44,275,000 attempts (1m 1s)
  address:     KUmoqSaxefUUBcJio8ECtq98HpGJKUT9DPEXDyjoemU
  private key (base58 — import into Phantom):        ...
  private key (JSON byte array — solana-cli id.json): [...]
```

## Install

```sh
npm install
npm run build
```

## CLI

The chain is a subcommand: `evm` (default, so all bare invocations stay EVM) or `sol`.

```sh
node dist/cli.js --prefix c0ffee               # EVM: starts with 0xc0ffee
node dist/cli.js evm --prefix AbCd --checksum  # EVM: exact EIP-55 capitalization
node dist/cli.js sol --prefix kumo --ignore-case  # SOL: starts with kumo/KuMo/KUMO/...
node dist/cli.js sol --suffix moon --count 2   # SOL: ends with moon (exact case), 2 matches
node dist/cli.js sol --contains BULL           # SOL: BULL anywhere, case-sensitive
node dist/cli.js sol --benchmark               # measure ed25519 rate (cached per chain)
node dist/cli.js --prefix cafe --save keys.txt # ALSO write to file (loud warning)
node dist/cli.js --help
```

| flag | meaning |
| --- | --- |
| `--prefix / --suffix / --contains <pat>` | where the pattern must appear |
| `--checksum` | **evm only** — case-sensitive EIP-55 match; ~2x harder per a-f letter |
| `--ignore-case` | **sol only** — match any capitalization; ~2x easier per letter (Solana addresses are case-sensitive by default) |
| `--count <n>` | find `n` matches (default 1) |
| `--workers <n>` | worker threads (default: all cores) |
| `--save <file>` | additionally write results to a plaintext file — prints a loud warning |
| `--benchmark` | measure and cache this machine's real addresses/sec for that chain |

While running you get a live status line: attempts, addr/sec, elapsed, and the
probability the match has been found by now. Before starting, it prints the
expected attempts and a time estimate at your machine's measured per-chain rate.

## EVM patterns (hex)

Addresses are hex: only `0-9` and `a-f`. Lookalikes for other letters:

| you want | use |
| --- | --- |
| o | 0 |
| i, l | 1 |
| z | 2 |
| s | 5 |
| g | 9 (or 6) |
| t | 7 |

Classics that work as-is: `c0ffee`, `decade`, `dead`, `beef`, `cafe`, `babe`,
`face`, `deadbeef`. Matching ignores case by default; `--checksum` makes the
EIP-55 display casing matchable (`0xAbCd...` exactly).

### EVM timing (measured: ~36,000 addr/s on this machine, 16 threads)

| length | expected attempts | time |
| --- | --- | --- |
| 4 | 65,536 | ~2 s |
| 5 | 1,048,576 | ~29 s |
| 6 | 16,777,216 | ~8 min |
| 7 | 268,435,456 | ~2 h |
| 8 | 4,294,967,296 | ~1.4 days |
| 10 | 1.1 × 10¹² | ~1 year |

## Solana patterns (base58)

Solana addresses are the base58 encoding of the ed25519 public key — full
words are possible, and they're **case-sensitive**. The base58 alphabet
deliberately excludes four lookalike characters:

| invalid | why | use instead |
| --- | --- | --- |
| `0` (zero) | looks like O | letter `o` |
| `O` (capital o) | looks like 0 | lowercase `o` |
| `I` (capital i) | looks like l/1 | lowercase `i` |
| `l` (lowercase L) | looks like I/1 | capital `L` or `1` |

Valid: `1-9`, `A-H J-N P-Z`, `a-k m-z`.

`--ignore-case` matches any capitalization — roughly 2x easier per letter,
since most letters exist in both cases in the alphabet (the single-case
letters `o`, `i`, `L` and digits gain nothing). The estimator computes this
per character rather than assuming a flat 33^length.

**First-character effect (real, and the estimator models it):** base58 of
32 bytes yields a 44-char address ~94% of the time, and a 44-char address can
only *start* with `2`–`J`. A prefix that starts with any other character
(e.g. lowercase `k` in `kumo`) only matches the ~6% of addresses that are
43 chars, making it ~17x harder than naive math suggests. Prefix estimates
account for this; picking a first character in `2`–`J` (or `--ignore-case`
with a letter whose uppercase lands there, like `Bull`) is dramatically faster.

### Solana private key formats

Both are printed (and saved) for every match — same key, two encodings:

- **base58 (64-byte secret)** — what **Phantom** imports: Settings → Manage
  Accounts → Import Private Key, paste the base58 string.
- **JSON byte array** — what **solana-cli** uses: save the `[12,34,...]` line
  as e.g. `id.json`, then `solana-keygen pubkey id.json` to verify it matches
  the address, and `solana config set --keypair /path/to/id.json` to use it.

### Solana timing (measured: ~760,000 addr/s on this machine, 16 threads)

Solana keygen is native (libsodium via sodium-native — ~11x faster than the
previous pure-JS ed25519, ~230x faster than tweetnacl), with preallocated
buffers in the hot loop, a hand-rolled base58 encoder (cross-checked against
bs58 at startup), and a first-byte pre-filter that rejects ~99% of candidates
before encoding in prefix mode. If sodium-native isn't available, it falls
back to OpenSSL via node's `crypto.generateKeyPairSync` — both are
benchmarked at startup and the faster one wins.

Case-sensitive prefix, first character in the reachable `2`–`J` range:

| length | expected attempts | time |
| --- | --- | --- |
| 3 | 195,112 | <1 s |
| 4 | 11,316,496 | ~15 s |
| 5 | 656,356,768 | ~14 min |
| 6 | 38,068,692,544 | ~14 h |
| 7 | 2.2 × 10¹² | ~33 days |
| 8 | 1.3 × 10¹⁴ | ~5 years |

Real examples with `--ignore-case`: `Bull` ≈ 1.6M attempts ≈ 2 s;
`kumo` ≈ 24M attempts ≈ 32 s (lowercase `k` pays the first-char penalty);
suffixes avoid the first-char effect entirely (`--suffix moon` ≈ 2.8M ≈ 4 s).

## Web UI

```sh
npm run web
# -> http://127.0.0.1:3939
```

One dark page with a chain switcher: **◆ EVM** / **◎ SOL** (Solana tab shifts
the accent to the purple→green gradient). Pattern input, prefix/suffix/contains,
per-chain case checkbox (EIP-55 checksum vs ignore case). Shows the difficulty
estimate *before* you start, then live attempts/sec and progress streamed over
SSE while the Node backend does the actual worker_threads grinding — **keys are
never generated in the browser**. Results show the address big, private key(s)
behind a reveal click (both Solana formats), copy buttons, stop button, and an
explicit save-to-file button with the same loud warning.

- The server binds to **127.0.0.1 only — never `0.0.0.0`** — so it is
  unreachable from your network. It also rejects requests whose `Host` header
  isn't localhost (DNS-rebinding guard), and the page ships a CSP that blocks
  all external origins.
- Keys are never logged server-side and never written to disk unless you click
  save and confirm.

## Security

### Randomness — and why not Profanity

Every candidate key is generated **fresh from the OS CSPRNG**:

- **EVM**: viem's `generatePrivateKey()` (backed by `crypto.getRandomValues`),
  address derived with viem's keccak/secp256k1 stack.
- **Solana**: native ed25519 keygen — libsodium's `crypto_sign_keypair`
  (sodium-native), whose seeds come from libsodium's `randombytes` OS-CSPRNG;
  or, as fallback, OpenSSL via node's `crypto.generateKeyPairSync('ed25519')`
  (seeded by the OS CSPRNG through OpenSSL RAND). **Only the key generation
  library changed for speed — the randomness source is the OS CSPRNG in every
  configuration.** Defense in depth: at startup every worker cross-checks the
  active keygen against two independent ed25519 implementations
  (`@noble/curves` and tweetnacl) and validates its fast base58 encoder
  against bs58; and every *found* key is re-verified before being reported by
  independently re-deriving the public key from the secret's seed and
  asserting it encodes to the found address.

No seeded PRNGs, no key incrementing, no shared state between attempts.

This tool deliberately does **not** use or port the "Profanity" vanity
generator's algorithm. Profanity seeded its keyspace from a weak 32-bit random
seed, which made every key it produced brute-forceable from the public address
alone. Real wallets were drained because of it — ~$3.3M swept from vanity
addresses in September 2022, and the related $160M Wintermute hack traced to a
Profanity-generated hot wallet. Avoid Profanity and its GPU forks entirely.

### Verifying this tool is offline

- **Runtime dependencies:** `viem` (EVM key/address math — no RPC transport is
  ever created), `sodium-native` (optional; libsodium ed25519), `@noble/curves`
  and `tweetnacl` (independent ed25519 cross-checks), `bs58` (base58
  cross-check). All pure crypto math; none can talk to the network.
- **Grep the source:** the only networking code in `src/` is the localhost HTTP
  server in `server.ts`, bound to `127.0.0.1`:
  ```sh
  grep -rn "fetch\|XMLHttpRequest\|net\.connect\|\.request(" src/
  ```
- **Audit the tree:** `npm ls --all` — no telemetry. The only install script
  belongs to `sodium-native` (`node-gyp-build`, the standard loader that picks
  its prebuilt libsodium binary; it makes no network requests at install).
- **The ultimate test:** disconnect Wi-Fi/Ethernet and run it. Everything works
  identically because nothing is fetched, ever.

### Before using a generated wallet

Send a **small test amount first** and confirm you can move it back out. Only
then use the wallet for anything real. Treat `--save` files as radioactive:
they contain plaintext private keys — import them into a proper wallet, then
delete the file. Never commit them (this repo's `.gitignore` already excludes
`vanity-keys-*.txt`).

Longer patterns mean the private key was still chosen from the full keyspace —
a vanity prefix does not weaken the key *when generated this way*.
