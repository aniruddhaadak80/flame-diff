"""The minimal edit script.

Myers' O(ND) difference algorithm, in its linear-space form (Myers 1986, §4b): the forward
and reverse D-paths are searched in lockstep until they overlap, and the split point is
found recursively. Memory stays O((N+M) log(N+M)) instead of the O(ND) trace an
edit-graph backtrack would need, which is what lets this run on real recordings.

Minimality and determinism are both properties worth money here, so both are tested:

  * minimality — the number of non-equal steps equals (N + M - 2 * LCS), checked against a
    brute-force longest-common-subsequence oracle on small inputs;
  * determinism — ties are broken by always preferring the deletion branch in the forward
    pass, so the same pair of inputs always yields byte-identical output.

Two levels are produced. `edit_ops` returns the flat step list; `hunks` groups consecutive
steps of the same operation into runs, which is what the CLI and the web app render.
"""

from __future__ import annotations

from .model import Hunk, Token
from .protocol import EngineError

OP_EQUAL = "equal"
OP_INSERT = "insert"
OP_DELETE = "delete"

_MAX_SPAN = 4_000_000


def edit_ops(a: list[str], b: list[str]) -> list[tuple[str, int, int]]:
    """Return the minimal edit script as (op, a_index, b_index) steps.

    `a_index` is the position in `a` (meaningful for equal/delete) and `b_index` the
    position in `b` (meaningful for equal/insert); the unused one is -1.
    """
    if len(a) + len(b) > _MAX_SPAN:  # pragma: no cover - a guard, not a reachable branch
        raise EngineError("INPUT_TOO_LARGE", f"refusing to diff {len(a)}+{len(b)} tokens")
    steps: list[tuple[str, int, int]] = []
    _solve(a, b, 0, len(a), 0, len(b), steps)
    return steps


def hunks(a: list[str], b: list[str], steps: list[tuple[str, int, int]]) -> list[Hunk]:
    """Group a flat edit script into runs of equal operation."""
    out: list[Hunk] = []
    for op, a_index, b_index in steps:
        token = a[a_index] if op in (OP_EQUAL, OP_DELETE) else b[b_index]
        if out and out[-1]["op"] == op and _continues(out[-1], op, a_index, b_index):
            current = out[-1]
            if op == OP_EQUAL:
                current["base_len"] += 1
                current["head_len"] += 1
            elif op == OP_DELETE:
                current["base_len"] += 1
            else:
                current["head_len"] += 1
            current["tokens"].append(token)
            continue

        if op == OP_EQUAL:
            out.append(
                {
                    "op": op,
                    "base_start": a_index,
                    "base_len": 1,
                    "head_start": b_index,
                    "head_len": 1,
                    "tokens": [token],
                }
            )
        elif op == OP_DELETE:
            out.append(
                {
                    "op": op,
                    "base_start": a_index,
                    "base_len": 1,
                    "head_start": -1,
                    "head_len": 0,
                    "tokens": [token],
                }
            )
        else:
            out.append(
                {
                    "op": op,
                    "base_start": -1,
                    "base_len": 0,
                    "head_start": b_index,
                    "head_len": 1,
                    "tokens": [token],
                }
            )
    return out


def _continues(hunk: Hunk, op: str, a_index: int, b_index: int) -> bool:
    if op == OP_EQUAL:
        return hunk["base_start"] + hunk["base_len"] == a_index
    if op == OP_DELETE:
        return hunk["base_start"] + hunk["base_len"] == a_index
    return hunk["head_start"] + hunk["head_len"] == b_index


def edit_script(a: list[Token], b: list[Token]) -> list[Hunk]:
    """The minimal edit script between two SIGNIFICANT token sequences, as runs."""
    left = [token["text"] for token in a]
    right = [token["text"] for token in b]
    return hunks(left, right, edit_ops(left, right))


def edit_cost(steps: list[tuple[str, int, int]]) -> int:
    """How many tokens had to change. The number that must be minimised to call it minimal."""
    return sum(1 for op, _, _ in steps if op != OP_EQUAL)


# --------------------------------------------------------------------------- the algorithm


def _solve(
    a: list[str],
    b: list[str],
    x0: int,
    x1: int,
    y0: int,
    y1: int,
    out: list[tuple[str, int, int]],
) -> None:
    """Emit the edit script for a[x0:x1] vs b[y0:y1] into `out`, in order."""
    left, right = a[x0:x1], b[y0:y1]

    # Trim the common prefix: it is always in an optimal script.
    offset = 0
    while offset < len(left) and offset < len(right) and left[offset] == right[offset]:
        out.append((OP_EQUAL, x0 + offset, y0 + offset))
        offset += 1

    # Trim the common suffix: ditto, but it must be emitted after the middle.
    suffix = 0
    while (
        suffix < len(left) - offset
        and suffix < len(right) - offset
        and left[len(left) - 1 - suffix] == right[len(right) - 1 - suffix]
    ):
        suffix += 1

    ax0, ax1 = x0 + offset, x1 - suffix
    by0, by1 = y0 + offset, y1 - suffix

    if ax0 == ax1 and by0 == by1:
        pass
    elif ax0 == ax1:
        for index in range(by0, by1):
            out.append((OP_INSERT, -1, index))
    elif by0 == by1:
        for index in range(ax0, ax1):
            out.append((OP_DELETE, index, -1))
    else:
        middle_a, middle_b = _middle_snake(a, b, ax0, ax1, by0, by1)
        _solve(a, b, ax0, middle_a, by0, middle_b, out)
        _solve(a, b, middle_a, ax1, middle_b, by1, out)

    for index in range(suffix):
        out.append((OP_EQUAL, ax1 + index, by1 + index))


def _middle_snake(a: list[str], b: list[str], x0: int, x1: int, y0: int, y1: int) -> tuple[int, int]:
    """Find a point on an optimal path through (x0,y0)-(x1,y1). Returns that point."""
    n, m = x1 - x0, y1 - y0
    delta = n - m
    odd = delta % 2 == 1
    pad = n + m + 2
    size = 2 * (n + m) + 5
    forward = [0] * size
    reverse = [0] * size
    forward[pad + 1] = 0
    reverse[pad + 1] = 0

    for d in range(n + m + 1):
        for k in range(-d, d + 1, 2):
            # Deletion first on ties: this is the determinism guarantee.
            if k == -d or (k != d and forward[pad + k - 1] < forward[pad + k + 1]):
                x = forward[pad + k + 1]
            else:
                x = forward[pad + k - 1] + 1
            y = x - k
            if y < 0 or y > m:
                continue
            while x < n and y < m and a[x0 + x] == b[y0 + y]:
                x += 1
                y += 1
            forward[pad + k] = x
            if odd and -(d - 1) <= delta - k <= d - 1:
                if x + reverse[pad + delta - k] >= n:
                    return x0 + x, y0 + y

        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and reverse[pad + k - 1] < reverse[pad + k + 1]):
                x = reverse[pad + k + 1]
            else:
                x = reverse[pad + k - 1] + 1
            y = x - k
            if y < 0 or y > m:
                continue
            while x < n and y < m and a[x0 + n - 1 - x] == b[y0 + m - 1 - y]:
                x += 1
                y += 1
            reverse[pad + k] = x
            if not odd and -d <= delta - k <= d:
                # The forward point must sit on the SAME diagonal as this reverse point.
                # The reverse pass is indexed by j = delta - k_reverse, so that diagonal
                # is delta - k here, not k.
                if forward[pad + delta - k] + x >= n:
                    return x0 + n - x, y0 + m - y

    return x1, y1  # pragma: no cover - the loops always return for a non-trivial pair