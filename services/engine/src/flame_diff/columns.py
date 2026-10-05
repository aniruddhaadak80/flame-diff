"""The columnar storage container, `FLDC` version 1.

A recording is stored one column per attribute rather than one row per span. That is not a
premature optimisation, it is the reason the product can answer "which columns changed?" —
a question a row store cannot answer without a full scan and a per-field comparison.

The format is line-oriented and ASCII-only, which keeps it diffable, greppable, and
byte-identical between the Python engine and the TypeScript port:

    FLDC1
    trace "t1"
    label "base run"
    spans 4
    columns 6
    span_id str 4
    "r" "a" "b" "c"
    parent_id str 4
    "" "r" "r" ""
    name str 4
    "http.handle" "cache.get" "db.query" "orphan"
    start_ns u64 4
    0 400 100 500
    dur_ns u64 4
    12000 200 3000 50
    depth u64 4
    0 1 1 0

Row order is canonical pre-order, so the container is canonical too. The guarantees, stated
exactly because "lossless" is the word this product leans on:

    encode(decode(x)) == x     for every valid container x — byte-for-byte stable
    decode(encode(t)) == t     up to span ORDER: the span set and every field survive

The order caveat is deliberate, not a leak. Rows are stored in canonical pre-order, so two
recordings that differ only in the order their spans were appended produce byte-identical
containers — which is the property the whole comparison depends on. Ordering information is
not lost: it is carried by `parent_id`, which is what defines the tree.

`depth` is stored even though it is derived. Storing it makes the container readable
without replaying the tree, and `decode` re-derives it and refuses a container whose
stored depth disagrees — a corrupt file fails loudly instead of rendering a wrong tree.
"""

from __future__ import annotations

from typing import Final

from .canonical import depths_of, order
from .escape import escape, unescape
from .model import COLUMNS, FLDC_MAGIC, Span, Trace
from .protocol import EngineError

DTYPE_U64: Final[str] = "u64"
DTYPE_STR: Final[str] = "str"

#: Cell separator for the value rows. A TAB, not a space: `escape` turns every tab into the
#: two characters `\t`, so a raw tab can never appear inside a quoted cell. A space separator
#: would make any span name containing a space ambiguous, which is a real name, not an edge
#: case.
SEPARATOR: Final[str] = "\t"

_DTYPES: Final[frozenset[str]] = frozenset({DTYPE_U64, DTYPE_STR})


def _column_values(trace: Trace) -> dict[str, list[object]]:
    """Every column's values, in canonical pre-order."""
    ordered = order(trace)
    by_id = {span["span_id"]: span for span in trace["spans"]}
    depths = depths_of(trace["spans"])
    return {
        "span_id": [span_id for span_id in ordered],
        "parent_id": [by_id[span_id]["parent_id"] or "" for span_id in ordered],
        "name": [by_id[span_id]["name"] for span_id in ordered],
        "start_ns": [by_id[span_id]["start_ns"] for span_id in ordered],
        "dur_ns": [by_id[span_id]["dur_ns"] for span_id in ordered],
        "depth": [depths[span_id] for span_id in ordered],
    }


def encode(trace: Trace) -> str:
    """Serialise a validated trace to the FLDC text form."""
    values = _column_values(trace)
    count = len(values["span_id"])
    lines = [
        FLDC_MAGIC,
        f"trace {escape(trace['trace_id'])}",
        f"label {escape(trace['label'])}",
        f"spans {count}",
        f"columns {len(COLUMNS)}",
    ]
    for column in COLUMNS:
        dtype = DTYPE_U64 if column in ("start_ns", "dur_ns", "depth") else DTYPE_STR
        cells = values[column]
        lines.append(f"{column} {dtype} {count}")
        if count == 0:
            lines.append("")
            continue
        if dtype == DTYPE_STR:
            lines.append(SEPARATOR.join(escape(str(cell)) for cell in cells))
        else:
            lines.append(SEPARATOR.join(str(int(cell)) for cell in cells))  # type: ignore[arg-type]
    return "\n".join(lines) + "\n"


def decode(text: str) -> Trace:
    """Parse the FLDC text form back into a trace, or raise with the offending line.

    CRLF input is accepted. The container is *written* with LF endings, but a file that has
    been through a Windows checkout or a text editor will carry CRLF, and refusing it would
    make the format fail on the platform most likely to touch it.
    """
    lines = text.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines or lines[0] != FLDC_MAGIC:
        raise EngineError("BAD_MAGIC", f"expected {FLDC_MAGIC} on the first line")

    cursor = 1

    def header(field: str) -> str:
        nonlocal cursor
        if cursor >= len(lines):
            raise EngineError("TRUNCATED", f"missing the {field!r} header")
        parts = lines[cursor].split(" ", 1)
        cursor += 1
        if len(parts) != 2 or parts[0] != field:
            raise EngineError("BAD_HEADER", f"expected a {field!r} header, got {lines[cursor - 1]!r}")
        return parts[1]

    trace_id = unescape(header("trace"))
    label = unescape(header("label"))
    declared_count = header("spans")
    if not declared_count.isdigit():
        raise EngineError("BAD_HEADER", f"'spans' must be a count, got {declared_count!r}")
    declared_columns = header("columns")
    if not declared_columns.isdigit() or int(declared_columns) != len(COLUMNS):
        raise EngineError(
            "UNSUPPORTED_COLUMNS",
            f"this build reads exactly {len(COLUMNS)} columns, container declares {declared_columns}",
        )

    columns: dict[str, list[object]] = {}
    for _ in range(len(COLUMNS)):
        if cursor >= len(lines):
            raise EngineError("TRUNCATED", "container ends before every column is declared")
        parts = lines[cursor].split(" ")
        cursor += 1
        if len(parts) != 3:
            raise EngineError("BAD_HEADER", f"malformed column header {lines[cursor - 1]!r}")
        name, dtype, raw_count = parts
        if name not in COLUMNS:
            raise EngineError("UNKNOWN_COLUMN", f"unknown column {name!r}")
        if name in columns:
            raise EngineError("DUPLICATE_COLUMN", f"column {name!r} appears twice")
        if dtype not in _DTYPES:
            raise EngineError("UNKNOWN_DTYPE", f"unsupported dtype {dtype!r} for column {name!r}")
        if not raw_count.isdigit():
            raise EngineError("BAD_HEADER", f"column {name!r} has a non-numeric count {raw_count!r}")

        count = int(raw_count)
        if cursor >= len(lines):
            raise EngineError("TRUNCATED", f"column {name!r} has no values")
        row = lines[cursor]
        cursor += 1
        if count == 0:
            if row != "":
                raise EngineError("BAD_ROW", f"column {name!r} is empty but carries values")
            columns[name] = []
            continue
        cells = row.split(SEPARATOR)
        if len(cells) != count:
            raise EngineError(
                "BAD_ROW",
                f"column {name!r} declares {count} values but the row has {len(cells)}",
            )
        columns[name] = [_cell(dtype, cell, name) for cell in cells]

    if cursor != len(lines):
        raise EngineError("TRAILING_DATA", f"{len(lines) - cursor} unread line(s) after the columns")

    spans = _spans_from(columns)
    trace: Trace = {"trace_id": trace_id, "label": label, "spans": spans}
    _assert_depth_agrees(trace, columns["depth"])
    return trace


def _cell(dtype: str, cell: str, column: str) -> object:
    if dtype == DTYPE_STR:
        return unescape(cell)
    if not cell.isdigit():
        raise EngineError("BAD_CELL", f"column {column!r} expects an unsigned integer, got {cell!r}")
    return int(cell)


def _spans_from(columns: dict[str, list[object]]) -> list[Span]:
    ids = [str(value) for value in columns["span_id"]]
    parents = [str(value) for value in columns["parent_id"]]
    names = [str(value) for value in columns["name"]]
    starts = [int(value) for value in columns["start_ns"]]
    durations = [int(value) for value in columns["dur_ns"]]

    if len({*ids}) != len(ids):
        raise EngineError("DUPLICATE_SPAN_ID", "span_id column has a repeated value")
    known = set(ids)

    spans: list[Span] = []
    for index, span_id in enumerate(ids):
        parent = parents[index]
        if parent and parent not in known:
            raise EngineError(
                "DANGLING_PARENT",
                f"span {span_id!r} names parent {parent!r}, which is not in the container",
            )
        spans.append(
            {
                "span_id": span_id,
                "parent_id": parent or None,
                "name": names[index],
                "start_ns": starts[index],
                "dur_ns": durations[index],
            }
        )
    return spans


def _assert_depth_agrees(trace: Trace, stored: list[object]) -> None:
    """A container whose stored depth contradicts its own tree is corrupt; say so."""
    derived = depths_of(trace["spans"])
    for index, span in enumerate(trace["spans"]):
        if derived[span["span_id"]] != int(stored[index]):  # type: ignore[arg-type]
            raise EngineError(
                "DEPTH_MISMATCH",
                f"column depth says {int(stored[index])} for span {span['span_id']!r}, "  # type: ignore[arg-type]
                f"but the tree says {derived[span['span_id']]}",
            )