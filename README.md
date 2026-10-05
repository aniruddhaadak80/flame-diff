<div align="center">

# Flame Diff

**Compare two execution recordings token by token, and prove the comparison faithful by
reconstructing the original from its own token stream.**

[CI](https://github.com/aniruddhaadak80/flame-diff/actions/workflows/ci.yml) ·
[License](https://github.com/aniruddhaadak80/flame-diff/blob/main/LICENSE) ·
[Issues](https://github.com/aniruddhaadak80/flame-diff/issues)

</div>

---

## What this is

You have two recordings of the same program — before a change and after — and you want to know
what actually changed. Flame Diff tells you, as a machine-readable answer rather than a picture:

- which spans **appeared**, **vanished**, were **renamed**, **moved deeper**, or got **slower**;
- the **minimal edit script** over the two recordings' token streams — the smallest possible set
  of token changes that turns one into the other;
- which **columns of the columnar store** moved, matched by `span_id`.

The unusual part is that it can prove it. Before showing you a number, it rebuilds each recording
from its own tokens and checks it came back byte-identical. If it did not, you are told, and the
verdict sits above the report rather than in a footer.

There is no model call anywhere in the comparison path. The answer is computed.

## Install

Requires Node 22.12+ and Python 3.11+.

```bash
git clone https://github.com/aniruddhaadak80/flame-diff.git
cd flame-diff
npm install
pip install -e services/engine
```

Confirm the install:

```bash
flame-diff doctor
```

```
flame-diff doctor
  [PASS] node     v22.23.2
  [PASS] package  flame-diff@0.1.0
  [PASS] engine   python reference engine responded (v0.1.0)
  [PASS] skills   5 skills, 0 invalid
  [PASS] plugins  2 active, 0 disabled
  [WARN] config   no product.config.json — using defaults
         fix: run with defaults, or create product.config.json

all required checks passed
```

The `engine` row is the one that matters. `PASS` means the Python reference answered. `WARN`
means it could not be reached and the TypeScript port answered instead — the report is still
correct, because both are held to the same golden output, but the fix is to install Python.

## Walkthrough

The repository ships a pair of sample recordings so every command below is runnable from a fresh
clone.

### 1. See the capabilities

```bash
flame-diff tools
```

Eight tools, all reachable from every surface. `trace_diff` is the flagship; the rest exist so the
MCP server and the web app never need a second implementation of anything.

### 2. Look at a recording in canonical form

```bash
flame-diff canonicalize fixtures/samples/before.fld
```

```console
$ flame-diff canonicalize fixtures/samples/before.fld
(trace "checkout-8f2a" "before - release 4.2.0" 18)
(span "s00" "http.handle" 0 214600
  (span "s01" "auth.verify" 1100 4200
    (span "s02" "jwt.decode" 1400 310
    )
    (span "s03" "session.load" 1900 2600
    )
  )
  (span "s04" "cart.load" 5800 18400
    (span "s05" "cache.get" 6000 420
    )
    (span "s06" "db.query.items" 6600 11900
      (span "s07" "db.pool.acquire" 6700 240
      )
      ... 38 lines in total
```

The stack tree as a nested s-expression, with the children of every node in the order they ran.
Order-independent: shuffle the input array and this text does not change.

### 3. Prove the comparison is faithful

```bash
flame-diff verify fixtures/samples/before.fld fixtures/samples/after.fld
```

```console
$ flame-diff verify fixtures/samples/before.fld fixtures/samples/after.fld
base: lossless   head: lossless
verdict: both recordings survived their own token stream
```

### 4. Compare them

```bash
flame-diff diff fixtures/samples/before.fld fixtures/samples/after.fld --changed-only
```

```console
$ flame-diff diff fixtures/samples/before.fld fixtures/samples/after.fld --changed-only
before - release 4.2.0 (18 spans)
vs
after - release 4.3.0 (20 spans)

  3 regressed   0 improved
  2 added         0 removed
  1 renamed      0 depth-shifted
  12 unchanged

  edit cost        32 token(s) — minimal edit script
  round trip       verified lossless
  orphans          0
  verdict: 6 change(s) to look at

timeline
! |         http.handle                     268.40us   +53.80us   +25.1%   ##########################################################################  s00
. ||        cache.get                       390ns      30ns       -7.2%    #  s05
. |||       db.pool.acquire                 250ns      +10ns      +4.2%    #  s07
~ ||        tax.calculate.v2                11.60us    +7.80us    +205.3%  ###  s09
+ |||       rules.load                      7.40us                         ##  s18
! |         receipt.write                   71.50us    +62.60us   +703.4%  ####################  s15
! ||        db.insert                       62.40us    +60.50us   +3184.2% #################  s17
+ |||       wal.flush                       60.10us                        #################  s19
```

One row per span, in the order the stack ran, with a left ruler of tick marks showing depth. `!`
regressed, `+` added, `-` removed, `~` renamed, `.` a sub-threshold change. The glyph legend is
in [`apps/web/components/Timeline.tsx`](apps/web/components/Timeline.tsx) and the same shape is
rendered by the web app.

Drop `--changed-only` to see all 20 rows. Add `--columns` for the per-column table and `--hunks`
for the token-level edit script.

### 5. Ask which attributes moved

```bash
flame-diff columns fixtures/samples/before.fld fixtures/samples/after.fld
```

```console
$ flame-diff columns fixtures/samples/before.fld fixtures/samples/after.fld
    span_id    +2  -0  ~0  =18
  parent_id    +2  -0  ~0  =18
       name    +2  -0  ~1  =17
    start_ns   +2  -0  ~0  =18
      dur_ns   +2  -0  ~6  =12
      depth    +2  -0  ~0  =18
```

`dur_ns` moved on six spans and `name` on one — the shape of the work is the same, it just got
slower. Spans are matched by `span_id`, so the two added spans are counted as additions rather
than shifting every column below them.

### 6. Look at the tokens

```bash
flame-diff tokenize fixtures/samples/before.fld
```

```console
$ flame-diff tokenize fixtures/samples/before.fld
    0..1     lparen  (
    1..6     sym     trace
    6..7     ws
    7..22    string  "checkout-8f2a"
   22..23    ws
   23..47    string  "before - release 4.2.0"
...

245 token(s), 133 significant, round trip verified lossless
```

Whitespace is a token too, which is what makes `detokenize(tokenize(s)) == s` true for every
string rather than only for canonical ones.

### 7. Use it as an HTTP API

```bash
curl -s localhost:3000/api/diff \
  -H 'content-type: application/json' \
  -d '{"base":{"trace_id":"t","spans":[{"span_id":"a","name":"x","start_ns":0,"dur_ns":100}]},
       "head":{"trace_id":"t","spans":[{"span_id":"a","name":"x","start_ns":0,"dur_ns":900}]}}'
```

`POST /api/diff` is the flagship surface. `GET /api/diff` documents itself, and
`GET /api/health` reports which engine implementation answered.

### 8. Connect an agent over MCP

Flame Diff is a tool provider for other agents, not only a client. Add it to an MCP client:

```json
{
  "mcpServers": {
    "flame-diff": {
      "command": "flame-diff",
      "args": ["mcp", "serve"]
    }
  }
}
```

To see the real handshake, run the proof script — it starts `mcp serve` as a child process and
speaks MCP to it over stdio:

```console
$ node scripts/mcp-proof.mjs
initialize            -> server flame-diff v0.1.0
tools/list            -> 8 tools
                         - list_plugins
                         - list_skills
                         - trace_canonicalize
                         - trace_columns
                         - trace_container
                         - trace_diff
                         - trace_tokenize
                         - trace_verify_roundtrip
tools/call trace_diff -> edit_cost=13 lossless=true
                         engine=python
                         stats: added=1 regressed=1
                         unchanged            http.handle
                         duration_regressed   db.query
                         added                retry.send
tools/call (invalid)  -> isError=true UNEXPECTED_CHARACTER: unexpected character "@" at offset 0
tools/call verify     -> lossless=true
closed cleanly
```

Note `engine=python`: that call reached the reference implementation, not the port. And note that
a refusal arrives carrying the engine's own stable code rather than a generic upstream failure —
a caller told only `UPSTREAM_FAILED` would have to guess why.

### 9. Run the whole gate

```bash
npm run check
```

This is the exact command CI runs, in the same order — so a green local run means a green CI run.

## The three guarantees

These are the product. Each one is asserted as a property over generated input, in both the
Python reference and the TypeScript port.

1. **The token stream loses nothing.** Every input is either tokenised losslessly or refused with
   a stable error code. `tokenizer.py` keeps whitespace as a token precisely so the round trip is
   unconditional.
2. **Canonicalisation is order-independent and idempotent.** Shuffling the order spans were
   appended cannot change the output, so a diff reflects real changes in the work and nothing
   else.
3. **The edit script is minimal.** Proved against a brute-force longest-common-subsequence oracle
   on small inputs, not estimated and not asserted by comparison with itself. Ties break toward
   deletion, so the same pair always gives byte-identical output.

Guarantee 3 caught a real bug during development: an indexing error in the reverse D-path that
compiled, terminated, and returned a _plausible but non-minimal_ script. Only the oracle noticed.

## Architecture

```
                 ┌──────────────┐
  CLI ──────────▶│              │
  JSON API ─────▶│  ToolRegistry│───▶ packages/memory   SQLite index over
  MCP server ───▶│  (8 tools)   │      the columnar payloads
                 └──────┬───────┘
                        │
                        ├──▶ services/engine        Python reference, stdin/stdout
                        └──▶ packages/tracekit      TypeScript port, same golden output
```

**The narrow waist.** Every capability is a `Tool` in one registry. The CLI, the REST route and
the MCP tool are three thin shells over one handler — not three implementations. A surface is a
transport, never a second code path.

**Why there are two engines.** `services/engine` is the reference implementation and owns the
behaviour. `packages/tracekit` is a TypeScript port that exists because Vercel runs the web app
in a Node function with no Python runtime, and a diff viewer that cannot compute a diff is a
screenshot. The port is held to the reference by `fixtures/golden/cases.json`, which **both** test
suites assert — so if they ever disagree about one byte, one of them goes red. That file also
caught the two real divergences found during this build: a floor-versus-truncate disagreement on
negative percentages, and an ordering inconsistency for cyclic recordings.

**The footprint ladder.** Where new capability goes, in order of preference:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool
4. Add a plugin — column codecs and classification rules
5. Add an MCP server tool
6. Add a new core tool — **last resort**

Every core tool is paid for in context window on every request, forever. Plugins are free. That
asymmetry is why adding to `packages/core` first is the most common review comment here.

## What ships

| Surface               | What it is                                                         |
| --------------------- | ------------------------------------------------------------------ |
| CLI                   | `diff`, `canonicalize`, `tokenize`, `columns`, `verify`, `doctor`  |
| JSON API              | `POST /api/diff`, `GET /api/health` — the flagship surface         |
| Web app               | form-first, server-rendered, deployed to Vercel                    |
| MCP server and client | real MCP over stdio, proven by a contract test                     |
| Python engine         | tokenizer, Myers diff, classifier, columnar codec — pure functions |
| TypeScript port       | the same engine for hosts with no Python runtime                   |
| Skills catalog        | five skills, frontmatter-validated, version-gated                  |
| Plugin registry       | two shipped plugins: a regression budget and a column profiler     |
| Memory                | SQLite with WAL, numbered migrations, indexing the payloads        |

### Deliberate omissions

**No desktop shell.** This product is api-first. An Electron shell is a strictly worse copy of a
URL, and it would add a ~250MB dependency tree to every install for no capability the web app
lacks.

**No channels.** flame-diff is local-first: it reads recordings you hand it. There is no remote
surface to talk to, so a channel adapter would have nothing to send.

**No model providers.** The entire value of this product is that the answer is computed rather
than generated. Shipping a model provider in a repository whose central claim is determinism
would contradict the claim.

**No telemetry.** `TELEMETRY_ENABLED` defaults to unset and `/api/health` reports `warn` while
it is off.

## Configuration

Layered, later wins: **defaults → `product.config.json` → environment**.

| Key                              | Default       | Meaning                                      |
| -------------------------------- | ------------- | -------------------------------------------- |
| `productEnv`                     | `development` | runtime mode                                 |
| `dataDir`                        | `.data`       | where SQLite lives                           |
| `engine.python`                  | `python`      | interpreter for the reference engine         |
| `engine.timeoutMs`               | `10000`       | ceiling on one engine call                   |
| `engine.allowTypeScriptFallback` | `true`        | use the port when Python is unreachable      |
| `diff.regressionRatio`           | `1.25`        | multiplier past which a span is a regression |
| `diff.minDurationNs`             | `0`           | ignore jitter below this duration            |
| `diff.maxHunks`                  | `5000`        | cap on emitted hunks                         |
| `logLevel`                       | `info`        | log verbosity                                |

An invalid value raises a `ValidationError` naming the field — it is never coerced.

## Data model

A recording is `{ trace_id, label, spans[] }`; a span is
`{ span_id, parent_id, name, start_ns, dur_ns }` with `parent_id` null for a root. Both
`trace_id` and `traceId` are accepted, as are the camelCase equivalents of every field —
normalisation happens once, at the engine boundary, in both languages.

`span_id` must be **stable across both recordings**. It is what matching uses, and it is why a
renamed function is reported as a rename rather than a delete plus an unrelated add.

Recordings are stored as the columnar `FLDC` container: one column per attribute, rows in
canonical order, tab-separated cells so a span name containing a space stays unambiguous.
`encode(decode(x))` is byte-stable.

## Documentation

| Page                                       | Read it when                              |
| ------------------------------------------ | ----------------------------------------- |
| [getting-started](docs/getting-started.md) | you have just cloned this                 |
| [architecture](docs/architecture.md)       | you need the map before changing anything |
| [cli](docs/cli.md)                         | you are scripting the CLI                 |
| [mcp](docs/mcp.md)                         | you are connecting an agent               |
| [skills](docs/skills.md)                   | you are writing or editing a skill        |
| [plugins](docs/plugins.md)                 | you are adding an extension               |
| [ci](docs/ci.md)                           | you are adding a gate                     |
| [troubleshooting](docs/troubleshooting.md) | something is broken                       |
| [adr/](docs/adr/)                          | you want the reasoning behind a decision  |

## Development

```bash
npm install
npm run build        # turbo build across every package
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm test             # vitest, every package
npm run pytest       # the Python engine, including property and golden tests
npm run check        # everything CI runs
python scripts/gen-samples.py       # regenerate sample containers and the web module
python services/engine/tools/gen_golden.py   # regenerate the cross-language golden file
```

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
