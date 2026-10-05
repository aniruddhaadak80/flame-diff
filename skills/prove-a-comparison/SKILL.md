---
name: prove-a-comparison
description: Use before acting on a trace diff or quoting its numbers, because faithfulness is provable here and an unproven comparison is the one way this tool can lie.
metadata:
  version: 1.0.0
---

# Prove a comparison is faithful

## When to use this

Any time a diff report is about to be pasted into a pull request, an incident note, or a
message to someone who will act on it.

## What is actually being claimed

Each recording is rendered in a canonical form, split into tokens, and reassembled from its own
tokens. If the text comes back byte-for-byte, the recording survived the round trip, and every
number in the report is a statement about the work rather than about serialisation.

## Steps

1. Prove both recordings survive:

   ```bash
   flame-diff verify before.fld after.fld
   ```

   Exits 0 and prints `verdict: both recordings survived their own token stream`.

2. See the tokens yourself:

   ```bash
   flame-diff tokenize before.fld
   ```

   Every line is `start..end kind text`. Whitespace is a token too, so concatenating every
   token reproduces the input exactly.

3. Read `edit cost` in the verdict block. That is the number of tokens a **minimal** edit script
   had to change — it is proved minimal against a brute-force longest-common-subsequence oracle,
   not estimated. Two recordings that differ only in the order their spans were appended cost 0.

## When faithfulness fails

`flame-diff verify` exits 1. When it does:

- the recording contains text outside the canonical grammar, most often an unterminated string in
  a span name;
- a span carries a negative duration;
- two spans share a `span_id`.

Fix the exporter. There is no partial-credit mode, deliberately: a comparison that cannot be
proved faithful is not a comparison.

## Verify

`flame-diff verify before.fld after.fld` exits 0.
