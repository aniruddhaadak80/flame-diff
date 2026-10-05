---
name: probe-columns
description: Use when you need to know which attributes of a recording actually moved rather than which spans differ, because recordings are stored one column per attribute and the two questions have different answers.
metadata:
  version: 1.0.0
---

# Probe the columnar store

## When to use this

A diff tells you which _spans_ changed. This tells you which _attributes_ changed, which is the
question you ask when you want to know whether a change was structural or just numeric.

## Steps

1. Ask which columns moved:

   ```bash
   flame-diff columns before.fld after.fld
   ```

   Columns are printed in the storage order: `span_id`, `parent_id`, `name`, `start_ns`,
   `dur_ns`, `depth`. The four counts per row are `added`, `removed`, `changed`, `unchanged`.

2. Read it like this:

   - `~changed` high on `dur_ns` only → the shape of the work is the same, it just got slower.
     This is a performance regression, not a refactor.
   - `~changed` high on `name` → renaming happened. Pair it with `flame-diff diff` to see whether
     a rename also moved the span.
   - `~changed` high on `depth` → the call structure changed. This is the one to read closely.
   - `added` high on `span_id` with `~changed` zero everywhere → work was added, nothing existing
     moved.

## Why spans are matched by id

Column deltas match spans by `span_id`, not by row position. Without that, inserting one span
near the top of the tree would report every column beneath it as changed, and the numbers would
be a function of ordering rather than of work.

## Inspect the container itself

The recording is stored as the columnar `FLDC` container. It is readable text:

```bash
flame-diff canonicalize before.fld
```

Writes the canonical rendering. `encode`/`decode` are byte-stable, and rows are stored in
canonical order, so two recordings that differ only in append order produce identical bytes.

## Verify

`flame-diff columns before.fld after.fld` prints six rows, and identical recordings report
`~0` on every column.
