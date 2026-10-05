# Configuration

Layered, later wins:

```
defaults  →  product.config.json  →  environment
```

The zod schema in `packages/config/src/schema.ts` is the **single source of truth**. The
settings UI derives its form from `z.toJSONSchema()` — that JSON Schema is never hand-written,
so the two cannot drift.

## Keys

| Key                              | Type    | Default       | Meaning                                                                         |
| -------------------------------- | ------- | ------------- | ------------------------------------------------------------------------------- |
| `productEnv`                     | enum    | `development` | one of development, test, production                                            |
| `dataDir`                        | string  | `.data`       | where SQLite and caches live                                                    |
| `engine.python`                  | string  | `python`      | interpreter for the reference engine                                            |
| `engine.timeoutMs`               | integer | `10000`       | hard ceiling on one engine call                                                 |
| `engine.allowTypeScriptFallback` | boolean | `true`        | use the TypeScript port when Python is unreachable                              |
| `diff.regressionRatio`           | number  | `1.25`        | multiplier past which a duration counts as a regression                         |
| `diff.minDurationNs`             | integer | `0`           | ignore duration changes below this many nanoseconds                             |
| `diff.maxHunks`                  | integer | `5000`        | cap on emitted hunks, so a pathological pair cannot produce an unbounded report |
| `logLevel`                       | enum    | `info`        | one of debug, info, warn, error                                                 |

### On `engine.allowTypeScriptFallback`

Set it to `false` where a Python runtime is guaranteed. Then a comparison that cannot reach the
reference **fails** rather than quietly answering from the port.

Leaving it `true` is a deployment convenience, not a licence to drift: `packages/tracekit` is
held to the reference by `fixtures/golden/cases.json`, which both test suites assert. See
[adr/0003-typescript-port-for-web.md](adr/0003-typescript-port-for-web.md).

`flame-diff doctor` tells you which implementation answered, and `/api/health` reports it too.

## Environment overlay

| Variable              | Maps to              |
| --------------------- | -------------------- |
| `PRODUCT_ENV`         | `productEnv`         |
| `PRODUCT_DATA_DIR`    | `dataDir`            |
| `PRODUCT_LOG_LEVEL`   | `logLevel`           |
| `PRODUCT_CONFIG_PATH` | the config file path |

## An invalid value is an error, never a coercion

Unknown keys are dropped rather than carried forward, and a value that fails validation
raises a `ValidationError` naming the failing field. Silently coercing `"loud"` to a log
level is how a typo becomes a debugging session.

## Secrets

Only `.env.example` is committed, and every value in it is empty.
`npm run check:no-secrets` fails if a `.env` with values is ever tracked.
