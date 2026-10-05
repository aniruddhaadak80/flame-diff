# ADR 0003 — The web app depends on the TypeScript port, not on Python

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

`apps/web` is the only part of this repository deployed to Vercel. The deterministic engine is
Python (`services/engine`), and Vercel runs the web app in a Node serverless function with **no
Python runtime**.

That leaves three honest options:

1. deploy the web app somewhere with a Python runtime;
2. reimplement the engine in TypeScript and let the two implementations drift;
3. port the engine to TypeScript, and hold the port to the reference with a shared fixture.

Option 2 is the failure mode this repository's whole architecture exists to prevent. A
"deterministic core" that has a second implementation is a claim, not a guarantee.

## Decision

`packages/tracekit` is a TypeScript port of the reference engine, and `apps/web` depends on it.

The port is not trusted. `fixtures/golden/cases.json` is generated from the **Python**
implementation by `services/engine/tools/gen_golden.py`, and both suites assert it:

- `services/engine/tests/test_golden.py` — the reference against its own output;
- `packages/tracekit/src/golden.test.ts` — the port against the same output.

If the two disagree about a single byte, exactly one of those suites goes red.

## Consequences

**Good**

- The deployed web app computes real diffs rather than rendering a mock.
- `vercel --prod` works from a bare checkout of `apps/web`.
- Drift between the two implementations is a test failure, not a field report.

**Bad**

- Two implementations of every engine function must be maintained in lockstep. This is real
  cost and it is the price of the deployment target.
- A change to engine behaviour requires regenerating the golden file, which is a visible diff.

### The golden file earned its keep

It caught two genuine divergences during this build, both of which compiled, ran, and produced
plausible output:

1. **Floor versus truncate.** Python's `//` rounds toward negative infinity; JavaScript's
   `Math.trunc` rounds toward zero. A 600ns drop on a 6800ns baseline reported `-882` in the port
   and `-883` in the reference. The port now does exact BigInt floor division.
2. **Ordering for cyclic recordings.** Detached spans were appended after real roots in one
   implementation, which made path-key order disagree with pre-order for exactly the tangled
   recordings where ordering is hardest to reason about.

Neither would have been found by a spot check.

## Alternatives rejected

**Deploy the engine behind an HTTP service.** Rejected: it makes a five-millisecond pure function
into a network dependency with a cold start, and it adds an availability requirement to a tool
whose value is that it always answers the same way.

**Implement the engine only in TypeScript.** Rejected for the mirror-image reason: Python is the
better home for a numerically careful, dependency-free core, and `mypy --strict` plus
`hypothesis` are worth more than anything the port gains.

**Let the web app render precomputed JSON.** Rejected: it makes the deployed app a screenshot of
a result rather than a tool that produces one.

## Related

- [ADR 0001 — the narrow waist](0001-narrow-waist.md)
- [ADR 0002 — the Python engine boundary](0002-python-engine-boundary.md)
- [ADR 0004 — columnar payloads, relational index](0004-columnar-payloads.md)
