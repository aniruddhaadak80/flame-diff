# ADR 0004 — Columnar payloads, relational index

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Two questions have to be answered by storage, and they pull in opposite directions:

1. **"Which attributes moved between these two recordings?"** — a question about _fields_.
2. **"Which recordings do I have, and what happened between them?"** — a question about _records_.

A row-per-span store answers (2) naturally and answers (1) by scanning every row and comparing
field by field, which is a full pass over the data to learn something structural.

flame-diff's whole premise is that a comparison should be exact and cheap. If storage cannot
report which columns moved, the product cannot either.

## Decision

**Split the two roles.**

- **Payloads are columnar.** A recording is stored as the `FLDC` container: one column per
  attribute, rows in canonical pre-order, cells separated by TAB. Six columns — `span_id`,
  `parent_id`, `name`, `start_ns`, `dur_ns`, `depth`.
- **The index is relational.** `packages/memory` is SQLite with WAL and numbered migrations. It
  stores the container text plus the facts worth querying, and nothing else.

A report is persisted as its **verdict** only — the counts, the edit cost, the faithfulness flag,
and the column deltas. The rows are recomputed from the two containers, because a persisted row
list would be a second thing that can disagree with the engine.

### Details that are load-bearing

- **Cells are TAB-separated, not space-separated.** `escape` turns every tab into the two
  characters `\t`, so a raw tab can never appear inside a quoted cell. A space separator makes
  any span name containing a space ambiguous — and a name containing a space is a real name, not
  an edge case.
- **`depth` is stored even though it is derived.** It makes the container readable without
  replaying the tree. `decode` re-derives it and refuses a container whose stored depth
  contradicts its own tree, so a corrupt file fails loudly instead of rendering a wrong flame
  graph.
- **Rows are in canonical order.** Two recordings that differ only in the order their spans were
  appended produce byte-identical containers. That is what makes the comparison order-independent
  all the way down to the file.

## Consequences

**Good**

- "Which columns moved" is a direct read of the layout, not a scan.
- `encode(decode(x))` is byte-stable, so a container can be committed and diffed in a pull
  request like source code.
- The index stays small and fast, because it holds containers and verdicts rather than spans.

**Bad**

- Two storage systems, and a reader who does not know the split will look in the wrong place.
- Reading a single span requires decoding the container. Acceptable: nothing in the product reads
  one span in isolation.

## Alternatives rejected

**Rows only, in SQLite.** Rejected: it makes the central question a full scan, and it makes the
recording payload depend on a native module being available. The container is plain text and can
be read with `cat`.

**Columnar only, no relational index.** Rejected: "which recordings do I have?" would need a
directory scan of the filesystem, which is not a query and cannot be indexed.

**Columnar payloads plus a persisted row list.** Rejected: the row list can drift from the
engine's output, and then the file is lying about the comparison.

## Related

- [ADR 0002 — the Python engine boundary](0002-python-engine-boundary.md)
- [ADR 0003 — the TypeScript port for the web app](0003-typescript-port-for-web.md)
