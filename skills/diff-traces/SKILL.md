---
name: diff-traces
description: Use when comparing two execution recordings to find out what changed and which change matters, because the flags and thresholds below decide what you act on.
metadata:
  version: 1.0.0
---

# Compare two recordings

## When to use this

You have a recording from before a change and one from after, and you need to know what moved.
This is the product's main workflow.

## Steps

1. Confirm both recordings are well-formed before believing any comparison:

   ```bash
   flame-diff verify before.fld after.fld
   ```

   It prints `base: lossless  head: lossless` or it prints the failure. **Do not read a report
   whose round trip failed** — the numbers describe serialisation, not work.

2. Run the comparison:

   ```bash
   flame-diff diff before.fld after.fld
   ```

3. Read the verdict block first, then the timeline. The timeline is one row per span, in the
   order the stack ran, with a left ruler showing depth.

4. Triage by flag, in this order — most actionable first:

   | Flag                 | What it means                      | First move                                  |
   | -------------------- | ---------------------------------- | ------------------------------------------- |
   | `duration_regressed` | slower past `--regression-ratio`   | look at what the span now calls             |
   | `added`              | new work that did not exist before | ask whether it should                       |
   | `renamed`            | same `span_id`, different `name`   | usually a refactor; check the duration flag |
   | `depth_shifted`      | moved deeper in the stack          | something now calls it from further down    |
   | `removed`            | present before, absent after       | confirm the work really went somewhere      |

5. A rename also carries a duration change. `flags` lists everything true about the row;
   `status` is only the most significant one.

## Thresholds

- `--regression-ratio 1.5` — only call something a regression past a 50% slowdown. Useful when
  the recording is noisy.
- `--min-duration-ns 1000` — ignore jitter on spans shorter than a microsecond. Without it,
  a 1ns wobble on a trivial span becomes a row.

## When the output is confusing

- `orphans` in the verdict counts spans whose parent is missing or on a cycle. Non-zero means the
  recording is tangled; fix the exporter before reading the timeline.
- Rows appear in **canonical order** (children sorted by when they started), not in the order
  spans were appended. Two recordings that differ only in append order produce an empty diff.
- `--changed-only` hides `unchanged` rows. `--columns` appends the per-column table.
  `--hunks` appends the minimal token edit script.

## Verify

`flame-diff verify before.fld after.fld` exits 0, and the timeline shows a non-zero edit cost
only when something genuinely differs.
