---
name: product-overview
description: Use when you need to know what Flame Diff actually guarantees and how to reach it, because the guarantees are the product and the commands are few.
metadata:
  version: 1.1.0
---

# Flame Diff

## What it is

A tool for comparing two execution recordings — the same program, before and after a change —
and reporting what appeared, vanished, got renamed, moved deeper, or got slower.

The point is not the picture. The point is that the answer is **computed**, and that you can
**prove** it was.

## The three guarantees

1. **The token stream loses nothing.** Every input is either tokenised losslessly or refused
   with a stable error code. Reassembling from tokens reproduces the input byte for byte.
2. **Canonicalisation is order-independent and idempotent.** Shuffling the order spans were
   appended in cannot change the output, so the diff only ever reflects real changes.
3. **The edit script is minimal.** Proved against a brute-force longest-common-subsequence
   oracle, not estimated. Deterministic: the same pair always gives the same answer.

All three are asserted as properties over generated input, in both the Python reference and the
TypeScript port, and both suites assert one shared golden file.

## Commands

```bash
flame-diff doctor                             # diagnose every subsystem, with fix hints
flame-diff tools                              # the authoritative capability list
flame-diff diff before.fld after.fld          # the main workflow
flame-diff verify before.fld after.fld        # prove the comparison is faithful
flame-diff canonicalize before.fld            # the canonical rendering
flame-diff tokenize before.fld                # the token stream
flame-diff columns before.fld after.fld       # which attributes moved
flame-diff mcp serve                          # expose the tools over MCP on stdio
flame-diff mcp call trace_diff '{...}'        # call one tool directly
flame-diff version                            # versions as JSON
```

Every read-only command takes `--json`.

## Recording format

A recording is `{ trace_id, label, spans[] }`, and each span is
`{ span_id, parent_id, name, start_ns, dur_ns }`. `parent_id` is null for a root. Both
`trace_id` and `traceId` spellings are accepted, as are `span_id`/`spanId` and so on.

`span_id` must be **stable across both recordings** — it is what matching uses, and it is why a
renamed function is reported as a rename rather than a delete plus an unrelated add.

## No model calls

There is no model provider in this repository, and that is deliberate: the value of the product
is that the answer is not generated. Nothing in the comparison path calls a model.

## Exit codes

`0` success, `1` runtime failure, `2` usage error.

## Verify

`flame-diff doctor` exits 0.
