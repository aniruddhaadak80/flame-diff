/**
 * `@flamediff/tracekit` — the TypeScript port of the deterministic engine.
 *
 * `services/engine` is the reference implementation and owns the behaviour. This package is
 * a port, not a rival: it exists because the deployed web app runs in a Node function where
 * Python is unavailable. `golden.test.ts` asserts the same `fixtures/golden/cases.json` that
 * the reference asserts, so the two cannot silently diverge.
 *
 * Read this before adding anything here: a function added to the port and not to the
 * reference is a second implementation of the product, which is the one thing this
 * repository's architecture forbids.
 */

export * from './types.js'
export * from './escape.js'
export * from './tokenizer.js'
export * from './canonical.js'
export * from './edit.js'
export * from './classify.js'
export * from './columns.js'
export * from './api.js'
