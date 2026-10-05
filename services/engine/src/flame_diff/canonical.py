"""The canonical rendering of a recording.

A trace is a forest of spans. The canonical form is that forest written as a nested
s-expression in pre-order, with the siblings of every node sorted by (name, start_ns,
span_id). Two properties follow, and both are asserted by tests:

  * order independence — shuffling the input `spans` array cannot change the output;
  * idempotence — canonicalizing a trace recovered from its own canonical form changes
    nothing.

That is what makes the token diff meaningful: the two token streams differ only where the
work differs, never because one recording happened to be serialised in a different order.
"""

from __future__ import annotations

from typing import Final

from .escape import escape
from .model import Span, Trace

INDENT: Final[str] = "  "


def _sort_key(span: Span) -> tuple[int, str, str]:
    """Sibling order, and one step of an ancestry path.

    `start_ns` leads deliberately. A flame graph is read as time moving downward, so children
    must come out in the order they ran. Name is the tiebreaker so two spans starting at the
    same instant still order deterministically, and `span_id` breaks any remaining tie.

    Ordering by name instead would be stable under rename but would render the stack
    backwards relative to how it executed, which is the one thing a flame graph must not do.
    """
    return (span["start_ns"], span["name"], span["span_id"])


class _Node:
    """One span in the rendered tree. Built once, then walked — no repeated scans."""

    __slots__ = ("span", "depth", "children")

    def __init__(self, span: Span, depth: int) -> None:
        self.span = span
        self.depth = depth
        self.children: list[_Node] = []


def build(trace: Trace) -> tuple[list[_Node], int]:
    """Return (root nodes, detached count).

    A span is detached when its parent is absent from the recording, or when it sits on a
    cycle. Detached spans are still rendered — as leaves, so they are visible in the report
    — but they are counted, because a recording that lost its tree is a fact the caller
    needs, not something to smooth over.
    """
    spans = trace["spans"]
    by_id: dict[str, Span] = {span["span_id"]: span for span in spans}

    orphans = 0
    children_of: dict[str, list[Span]] = {}
    for span in spans:
        parent = span["parent_id"]
        if parent is None or parent not in by_id:
            if parent is not None:
                orphans += 1
            continue
        children_of.setdefault(parent, []).append(span)

    for bucket in children_of.values():
        bucket.sort(key=_sort_key)

    roots: list[_Node] = []
    visited: set[str] = set()

    # Iterative DFS from every root. Explicitly iterative so a recording 10k spans deep
    # cannot exhaust the interpreter's stack.
    for root_span in sorted(
        (span for span in spans if span["parent_id"] is None or span["parent_id"] not in by_id),
        key=_sort_key,
    ):
        if root_span["span_id"] in visited:
            continue
        siblings: list[_Node] = []
        stack: list[tuple[Span, list[_Node], int]] = [(root_span, siblings, 0)]
        while stack:
            span, target, index = stack.pop()
            if span["span_id"] in visited:
                continue
            node = _Node(span, index)
            visited.add(span["span_id"])
            target.append(node)
            kids = children_of.get(span["span_id"], [])
            # Reversed, because the stack pops last-in first.
            for offset in range(len(kids) - 1, -1, -1):
                stack.append((kids[offset], node.children, index + 1))
        roots.extend(siblings)

    # Anything unvisited is on a cycle. Render it as a leaf and count it.
    #
    # Merged back into the root list and re-sorted, NOT appended: a detached span is a root
    # like any other, and leaving it at the end would make path-key order disagree with
    # pre-order for exactly the tangled recordings where ordering is hardest to reason about.
    tangled = [span for span in spans if span["span_id"] not in visited]
    tangled.sort(key=_sort_key)
    for span in tangled:
        orphans += 1
        roots.append(_Node(span, 0))

    roots.sort(key=lambda node: _sort_key(node.span))
    return roots, orphans


def walk(trace: Trace) -> tuple[list[_Node], int]:
    """Every span as a node, in pre-order, plus the detached count.

    This is the single ordering authority in the product: the canonical renderer, the
    columnar codec and the classifier all read pre-order from here, so they cannot drift.
    """
    roots, orphans = build(trace)
    ordered: list[_Node] = []
    for root in roots:
        pending = [root]
        while pending:
            node = pending.pop()
            ordered.append(node)
            pending.extend(reversed(node.children))
    return ordered, orphans


def order(trace: Trace) -> list[str]:
    """Span ids in canonical pre-order."""
    return [node.span["span_id"] for node in walk(trace)[0]]


def paths(trace: Trace) -> dict[str, tuple[tuple[str, int, str], ...]]:
    """Ancestry path per span id, as a tuple of sort keys from the root down.

    Because every step of a path is the same triple used to order siblings, sorting spans
    by path key yields exactly pre-order. That equivalence is what lets the classifier merge
    two recordings with an ordinary sorted merge and still place removals where they belong.
    """
    result: dict[str, tuple[tuple[str, int, str], ...]] = {}
    for root in build(trace)[0]:
        pending = [(root, ())]
        while pending:
            node, prefix = pending.pop()
            key = (*prefix, _sort_key(node.span))
            result[node.span["span_id"]] = key
            for child in node.children:
                pending.append((child, key))
    return result


def depths_of(spans: list[Span]) -> dict[str, int]:
    """Depth per span id. Public because the classifier and the columnar codec need it."""
    trace: Trace = {"trace_id": "", "label": "", "spans": spans}
    return {node.span["span_id"]: node.depth for node in walk(trace)[0]}


def render(trace: Trace) -> tuple[str, int]:
    """Return (canonical text, detached count) for a validated trace."""
    roots, orphans = build(trace)
    lines: list[str] = [
        f"(trace {escape(trace['trace_id'])} {escape(trace['label'])} {len(trace['spans'])})"
    ]
    emitted = 0

    def emit(node: _Node) -> None:
        nonlocal emitted
        span = node.span
        emitted += 1
        lines.append(
            f"{INDENT * node.depth}(span {escape(span['span_id'])} {escape(span['name'])} "
            f"{span['start_ns']} {span['dur_ns']}"
        )
        for child in node.children:
            emit(child)
        lines.append(f"{INDENT * node.depth})")

    for root in roots:
        emit(root)
    lines.append(")")

    if emitted != len(trace["spans"]):  # pragma: no cover - a total function by construction
        raise AssertionError(f"canonical render emitted {emitted} of {len(trace['spans'])} spans")
    return "\n".join(lines), orphans


def canonicalize(trace: Trace) -> str:
    """The canonical text for a validated trace. Pure."""
    return render(trace)[0]