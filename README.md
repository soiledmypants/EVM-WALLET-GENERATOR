# vanity-evm

Local vanity EVM address generator. Brute-forces random keypairs across all your
CPU cores until the address matches your pattern, then prints the address and
private key **to your terminal only**. Ships a CLI and a localhost-only web UI.
**Nothing ever leaves your machine — the tool makes zero network calls.**

```
pattern:            prefix "c0ffee"
expected attempts:  16,777,216 per match (50% chance within 11,626,611)
measuring machine:  ~28,306 addr/s (cached from last measured run)
estimated time:     ~9m 53s

match 1/1 after 9,441,500 attempts (5m 32s)
  address:     0xc0ffee...
  private key: 0x...
```

## Install

```sh
npm install
npm run build
```

## CLI

```sh
node dist/cli.js --prefix c0ffee          # starts with 0xc0ffee
node dist/cli.js --suffix dead            # ends with ...dead
node dist/cli.js --contains beef          # beef anywhere in the address
node dist/cli.js --prefix AbCd --checksum # exact EIP-55 capitalization
node dist/cli.js --prefix cafe --count 3  # keep going until 3 matches
node dist/cli.js --prefix cafe --workers 8
node dist/cli.js --prefix cafe --save keys.txt   # ALSO write to file (loud warning)
node dist/cli.js --benchmark              # measure this machine's addr/sec
node dist/cli.js --help
```

| flag | meaning |
| --- | --- |
| `--prefix <hex>` | address starts with `<hex>` (right after the `0x`) |
| `--suffix <hex>` | address ends with `<hex>` |
| `--contains <hex>` | address contains `<hex>` anywhere |
| `--checksum` | case-sensitive EIP-55 match — the a-f letter casing in your pattern must appear exactly (digits unaffected). ~2x harder per letter |
| `--count <n>` | find `n` matches (default 1) |
| `--workers <n>` | worker threads (default: all cores) |
| `--save <file>` | additionally write results to a plaintext file — prints a loud warning |
| `--benchmark` | measure and cache this machine's real addresses/sec |

While running you get a live status line: attempts, addr/sec, elapsed, and the
probability the match has been found by now. Before starting, it prints the
expected number of attempts and a time estimate at your machine's measured rate.

## What patterns are possible

Addresses are hex, so patterns may only use `0-9` and `a-f`. Words like "kumo"
can't literally appear in an address — use hex lookalikes where they exist:

| you want | use |
| --- | --- |
| o | 0 |
| i, l | 1 |
| z | 2 |
| e | 3 (or the literal `e`) |
| s | 5 |
| g | 9 (or 6) |
| t | 7 |
| b | 8 (or the literal `b`) |

Classics that work as-is: `c0ffee`, `decade`, `dead`, `beef`, `cafe`, `babe`,
`face`, `add`, `ace`, `0ddba11`, `5eed`, `b00b5`, `deadbeef`.

`--checksum` makes letter *casing* matchable: EIP-55 checksumming capitalizes
letters pseudo-randomly based on the address hash, so `--prefix AbCd --checksum`
finds an address that displays as exactly `0xAbCd...` in wallets. Each a-f
letter in the pattern roughly doubles the difficulty.

## How long will it take

Expected attempts = `16^length` for a plain hex prefix/suffix (`contains` is a
bit easier; each checksummed letter multiplies by ~2). Measured on this machine
(16 threads, ~28,300 addr/s — run `--benchmark` for your own number):

| length | expected attempts | time at 28.3k addr/s |
| --- | --- | --- |
| 4 | 65,536 | ~2 s |
| 5 | 1,048,576 | ~37 s |
| 6 | 16,777,216 | ~10 min |
| 7 | 268,435,456 | ~2.6 h |
| 8 | 4,294,967,296 | ~1.8 days |
| 10 | 1.1 × 10¹² | ~1.2 years |

These are *means* of a geometric distribution — you hit 50% odds at ~0.69× the
expected count, but an unlucky run can take several times longer. The search is
memoryless: time already spent never makes the next attempt more likely.

## Web UI

```sh
npm run web
# -> http://127.0.0.1:3939
```

Single dark page: pattern input, prefix/suffix/contains, checksum toggle. Shows
the difficulty estimate *before* you start, then live attempts/sec and progress
streamed over SSE while the Node backend does the actual worker_threads
grinding — **keys are never generated in the browser**. The result shows the
address big, with the private key hidden behind a reveal click, copy buttons,
a stop button, and an explicit save-to-file button with the same loud warning.

- The server binds to **127.0.0.1 only — never `0.0.0.0`** — so it is
  unreachable from your network. It also rejects requests whose `Host` header
  isn't localhost (DNS-rebinding guard), and the page ships a CSP that blocks
  all external origins.
- Keys are never logged server-side and never written to disk unless you click
  save and confirm.

## Security

### Randomness — and why not Profanity

Every candidate key is generated **fresh from the OS CSPRNG** via viem's
`generatePrivateKey()` (backed by `crypto.getRandomValues`), and the address is
derived with viem's keccak/secp256k1 stack. No seeded PRNGs, no key
incrementing, no shared state between attempts.

This tool deliberately does **not** use or port the "Profanity" vanity
generator's algorithm. Profanity seeded its keyspace from a weak 32-bit random
seed, which made every key it produced brute-forceable from the public address
alone. Real wallets were drained because of it — ~$3.3M swept from vanity
addresses in September 2022, and the related $160M Wintermute hack traced to a
Profanity-generated hot wallet. Avoid Profanity and its GPU forks entirely.

### Verifying this tool is offline

- **One runtime dependency:** `viem`, used purely for key/address math. No RPC
  transport is ever created, so it has no way to talk to the network.
- **Grep the source:** the only networking code in `src/` is the localhost HTTP
  server in `server.ts`, bound to `127.0.0.1`:
  ```sh
  grep -rn "fetch\|XMLHttpRequest\|net\.connect\|\.request(" src/
  ```
- **Audit the tree:** `npm ls --all` — no postinstall scripts, no telemetry.
- **The ultimate test:** disconnect Wi-Fi/Ethernet and run it. Everything works
  identically because nothing is fetched, ever.

### Before using a generated wallet

Send a **small test amount first** and confirm you can move it back out. Only
then use the wallet for anything real. Treat `--save` files as radioactive:
they contain plaintext private keys — import them into a proper wallet, then
delete the file. Never commit them (this repo's `.gitignore` already excludes
`vanity-keys-*.txt`).

Longer patterns mean the private key was still chosen from the full 2²⁵⁶
keyspace — a vanity prefix does not weaken the key *when generated this way*.
