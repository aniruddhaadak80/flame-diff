"""Turning two recordings into one report.

Two views of the same change, because they answer different questions:

  * the token edit script (see `edit`) is *structural* and *provably minimal* — it is the
    proof that the comparison touched as little as possible;
  * this module is *semantic* — it says what actually happened to the work: appeared,
    disappeared, got renamed, moved deeper, got slower, moved.

Spans are matched by `span_id`, which is what a recorder can keep stable across two runs.
Matching is by id and not by name, so a renamed function is reported as a rename rather
than as a removal plus an unrelated addition. Removals are then spliced back into the
head recording's position using the canonical path key, so the timeline reads top to bottom
the way the stack actually did.

Every threshold that decides a status is passed in. Nothing here reads a clock.
"""

from __future__ import annotations

from .canonical import order, paths
from .model import Row, Span, Stats, Trace

STATUS_ADDED = "added"
STATUS_REMOVED = "removed"
STATUS_RENAMED = "renamed"
STATUS_DEPTH_SHIFTED = "depth_shifted"
STATUS_REGRESSED = "duration_regressed"
STATUS_IMPROVED = "duration_improved"
STATUS_REORDERED = "reordered"
STATUS_DURATION_CHANGED = "duration_changed"
STATUS_UNCHANGED = "unchanged"

#: Highest-precedence first. The `status` of a row is the first flag that applies; `flags`
#: keeps all of them, so nothing is lost by showing one.
#:
#: `reordered` is deliberately NOT here. Canonical sibling order is decided by
#: (name, start_ns, span_id), so two spans that both survive can never trade places on their
#: own — a span only moves because it was renamed. Reporting "reordered" as a primary status
#: would name a symptom as the cause. It is kept as a flag, where it says something useful:
#: this span also moved position among its siblings.
PRECEDENCE: tuple[str, ...] = (
    STATUS_RENAMED,
    STATUS_DEPTH_SHIFTED,
    STATUS_REGRESSED,
    STATUS_IMPROVED,
    STATUS_DURATION_CHANGED,
    STATUS_UNCHANGED,
)


def _bps(delta_ns: int, base_ns: int) -> int | None:
    """Basis points of change, as an integer. Integers keep the two implementations honest.

    Rounds toward negative infinity, which is what `//` already does. The TypeScript port has
    to reach for BigInt to match, because JavaScript's `Math.trunc` rounds toward zero and
    `Math.floor(delta * 10000 / base)` is not reliably integer floor division once the float
    multiply rounds. The golden test caught this exact divergence, which is the argument for
    having it.

    A regression rounds down, so it understates how much worse things got; an improvement
    rounds down too, so it understates how much better. Both err towards "less dramatic",
    which is the right direction for a report someone acts on.
    """
    if base_ns <= 0:
        return None
    return (delta_ns * 10_000) // base_ns


def _ordinals(trace: Trace, restrict_to: set[str] | None = None) -> dict[str, int]:
    """Position of each span among its ordered siblings, in canonical order.

    `restrict_to` limits the count to spans that exist in both recordings. Without it,
    deleting a span shifts every later sibling up by one and the report calls that a
    reordering — an artefact of the deletion, not a change in the work. Both recordings are
    therefore indexed against the same surviving set, so a `reordered` flag always means a
    span genuinely moved relative to the spans it still competes with.
    """
    by_id = {span["span_id"]: span for span in trace["spans"]}
    ordered = [span_id for span_id in order(trace) if restrict_to is None or span_id in restrict_to]

    buckets: dict[str, list[str]] = {}
    roots: list[str] = []
    for span_id in ordered:
        parent = by_id[span_id]["parent_id"]
        if parent is None or parent not in by_id:
            roots.append(span_id)
        else:
            buckets.setdefault(parent, []).append(span_id)

    result: dict[str, int] = {}
    for span_id in ordered:
        parent = by_id[span_id]["parent_id"]
        siblings = roots if parent is None or parent not in by_id else buckets[parent]
        result[span_id] = siblings.index(span_id)
    return result


def classify(
    base: Trace,
    head: Trace,
    regression_ratio: float = 1.25,
    min_duration_ns: int = 0,
) -> tuple[list[Row], Stats]:
    """Return (rows in timeline order, aggregate stats). Pure."""
    base_by_id = {span["span_id"]: span for span in base["spans"]}
    head_by_id = {span["span_id"]: span for span in head["spans"]}

    base_depths = {span_id: len(path) - 1 for span_id, path in paths(base).items()}
    head_paths = paths(head)
    head_depths = {span_id: len(path) - 1 for span_id, path in head_paths.items()}

    # Sibling position is measured against the spans that survive, in both recordings, so a
    # removal cannot masquerade as a reordering.
    surviving = set(base_by_id) & set(head_by_id)
    base_ordinals = _ordinals(base, surviving)
    head_ordinals = _ordinals(head, surviving)

    head_order = order(head)
    base_paths = paths(base)

    removed = sorted(
        ((base_paths[span_id], span_id) for span_id in order(base) if span_id not in head_by_id)
    )

    rows: list[Row] = []
    cursor = 0
    for span_id in head_order:
        head_key = head_paths[span_id]
        while cursor < len(removed) and removed[cursor][0] < head_key:
            gone = base_by_id[removed[cursor][1]]
            rows.append(
                {
                    "span_id": gone["span_id"],
                    "name": gone["name"],
                    "depth": base_depths[gone["span_id"]],
                    "status": STATUS_REMOVED,
                    "flags": [STATUS_REMOVED],
                    "base_dur_ns": gone["dur_ns"],
                    "head_dur_ns": None,
                    "delta_ns": None,
                    "delta_bps": None,
                    "base_depth": base_depths[gone["span_id"]],
                }
            )
            cursor += 1
        rows.append(
            _row(
                base_by_id.get(span_id),
                head_by_id[span_id],
                base_depths.get(span_id),
                head_depths[span_id],
base_ordinals.get(span_id),
                    head_ordinals.get(span_id),
                regression_ratio,
                min_duration_ns,
            )
        )
    while cursor < len(removed):
        gone = base_by_id[removed[cursor][1]]
        rows.append(
            {
                "span_id": gone["span_id"],
                "name": gone["name"],
                "depth": base_depths[gone["span_id"]],
                "status": STATUS_REMOVED,
                "flags": [STATUS_REMOVED],
                "base_dur_ns": gone["dur_ns"],
                "head_dur_ns": None,
                "delta_ns": None,
                "delta_bps": None,
                "base_depth": base_depths[gone["span_id"]],
            }
        )
        cursor += 1

    return rows, stats_of(rows)


def _row(
    base: Span | None,
    head: Span,
    base_depth: int | None,
    head_depth: int,
    base_ordinal: int | None,
    head_ordinal: int,
    regression_ratio: float,
    min_duration_ns: int,
) -> Row:
    if base is None:
        return {
            "span_id": head["span_id"],
            "name": head["name"],
            "depth": head_depth,
            "status": STATUS_ADDED,
            "flags": [STATUS_ADDED],
            "base_dur_ns": None,
            "head_dur_ns": head["dur_ns"],
            "delta_ns": None,
            "delta_bps": None,
            "base_depth": None,
        }

    flags: list[str] = []
    delta_ns = head["dur_ns"] - base["dur_ns"]
    base_dur = base["dur_ns"]

    if base["name"] != head["name"]:
        flags.append(STATUS_RENAMED)
    if base_depth is not None and base_depth != head_depth:
        flags.append(STATUS_DEPTH_SHIFTED)
    if base_ordinal is not None and base_ordinal != head_ordinal:
        flags.append(STATUS_REORDERED)

    if delta_ns == 0 or max(base_dur, head["dur_ns"]) < min_duration_ns:
        flags.append(STATUS_UNCHANGED)
    elif base_dur > 0 and head["dur_ns"] >= base_dur * regression_ratio:
        flags.append(STATUS_REGRESSED)
    elif head["dur_ns"] > 0 and base_dur >= head["dur_ns"] * regression_ratio:
        flags.append(STATUS_IMPROVED)
    else:
        flags.append(STATUS_DURATION_CHANGED)

    return {
        "span_id": head["span_id"],
        "name": head["name"],
        "depth": head_depth,
        "status": next(status for status in PRECEDENCE if status in flags),
        "flags": flags,
        "base_dur_ns": base_dur,
        "head_dur_ns": head["dur_ns"],
        "delta_ns": delta_ns,
        "delta_bps": _bps(delta_ns, base_dur),
        "base_depth": base_depth,
    }


def stats_of(rows: list[Row]) -> Stats:
    counts = {status: 0 for status in PRECEDENCE}
    counts[STATUS_ADDED] = 0
    counts[STATUS_REMOVED] = 0
    reordered = 0
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
        if STATUS_REORDERED in row["flags"]:
            reordered += 1
    return {
        "total_rows": len(rows),
        "added": counts[STATUS_ADDED],
        "removed": counts[STATUS_REMOVED],
        "renamed": counts[STATUS_RENAMED],
        "depth_shifted": counts[STATUS_DEPTH_SHIFTED],
        "duration_regressed": counts[STATUS_REGRESSED],
        "duration_improved": counts[STATUS_IMPROVED],
        # Counted as a flag, because it is never a primary status.
        "reordered": reordered,
        "unchanged": counts[STATUS_UNCHANGED],
        "orphans": 0,
    }