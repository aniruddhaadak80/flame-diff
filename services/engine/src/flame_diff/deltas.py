"""Per-column deltas.

The question the columnar layout exists to answer: between these two recordings, which
*attributes* moved, and how much?

Spans are matched by `span_id`, so a column delta is a statement about the same spans the
report lists — not about row positions. That distinction matters: without id matching, a
span inserted near the top of the tree would report every column below it as changed.
"""

from __future__ import annotations

from .model import COLUMNS, ColumnDelta, Trace

_EMPTY = object()


def column_deltas(base: Trace, head: Trace) -> list[ColumnDelta]:
    """How each column moved between two recordings. Pure."""
    from .canonical import depths_of  # local import keeps the module graph acyclic

    base_by_id = {span["span_id"]: span for span in base["spans"]}
    head_by_id = {span["span_id"]: span for span in head["spans"]}
    base_depths = depths_of(base["spans"])
    head_depths = depths_of(head["spans"])

    added = len(set(head_by_id) - set(base_by_id))
    removed = len(set(base_by_id) - set(head_by_id))
    shared = [span_id for span_id in head_by_id if span_id in base_by_id]

    deltas: list[ColumnDelta] = []
    for column in COLUMNS:
        changed = 0
        unchanged = 0
        for span_id in shared:
            left = _value(base_by_id[span_id], column, base_depths)
            right = _value(head_by_id[span_id], column, head_depths)
            if left == right:
                unchanged += 1
            else:
                changed += 1
        deltas.append(
            {
                "column": column,
                "added": added,
                "removed": removed,
                "changed": changed,
                "unchanged": unchanged,
            }
        )
    return deltas


def _value(span: dict[str, object], column: str, depths: dict[str, int]) -> object:
    if column == "span_id":
        return span["span_id"]
    if column == "depth":
        return depths[str(span["span_id"])]
    value = span.get(column, _EMPTY)
    return "" if value is None else value