"""The typed I/O contract.

Every operation in this engine takes one of these shapes and returns one of these shapes.
Nothing here reads a clock, a socket, or the filesystem: the contract is deliberately a
value type, because the whole product rests on the claim that the same input always
produces the same output.

`depth` is deliberately NOT a stored field. It is derived from the parent chain every time
it is needed, so a recording cannot claim a depth that contradicts its own tree.
"""

from __future__ import annotations

from typing import Any, Final, TypedDict

from .protocol import EngineError

# The columnar storage layout, and the order the web timeline renders in. One entry per
# span attribute. `depth` is the only derived column.
COLUMNS: Final[tuple[str, ...]] = (
    "span_id",
    "parent_id",
    "name",
    "start_ns",
    "dur_ns",
    "depth",
)

#: Sentinel distinguishing "absent" from "present and None", so `parent_id: null` is honoured
#: while a genuinely missing field still raises.
_MISSING: Final[object] = object()

#: The on-disk magic for the columnar container. Version 1.
FLDC_MAGIC: Final[str] = "FLDC1"


class Span(TypedDict):
    """One recorded interval of work. `parent_id` is None for a root span."""

    span_id: str
    parent_id: str | None
    name: str
    start_ns: int
    dur_ns: int


class Trace(TypedDict):
    """One recording of a program's execution: a forest of spans under a label."""

    trace_id: str
    label: str
    spans: list[Span]


class Token(TypedDict):
    """A typed lexeme with byte-exact, half-open [start, end) offsets into the source."""

    kind: str
    text: str
    start: int
    end: int


class Hunk(TypedDict):
    """One run of the edit script. Offsets index the SIGNIFICANT token sequence."""

    op: str
    base_start: int
    base_len: int
    head_start: int
    head_len: int
    tokens: list[str]


class ColumnDelta(TypedDict):
    """How one column moved between two recordings, matched by span_id."""

    column: str
    added: int
    removed: int
    changed: int
    unchanged: int


class Row(TypedDict):
    """One line of the report: the single-column timeline the web app renders."""

    span_id: str
    name: str
    depth: int
    status: str
    flags: list[str]
    base_dur_ns: int | None
    head_dur_ns: int | None
    delta_ns: int | None
    delta_bps: int | None
    base_depth: int | None


class Roundtrip(TypedDict):
    """The faithfulness verdict: did the recording survive its own token stream intact?"""

    base_verified: bool
    head_verified: bool
    lossless: bool


class Stats(TypedDict):
    total_rows: int
    added: int
    removed: int
    renamed: int
    depth_shifted: int
    duration_regressed: int
    duration_improved: int
    reordered: int
    unchanged: int
    orphans: int


class Report(TypedDict):
    """The product's flagship value. Everything the UI, the CLI and MCP render."""

    base: dict[str, Any]
    head: dict[str, Any]
    stats: Stats
    rows: list[Row]
    column_deltas: list[ColumnDelta]
    hunks: list[Hunk]
    edit_cost: int
    roundtrip: Roundtrip


# --------------------------------------------------------------------------- validation


def _require_str(value: Any, field: str, where: str) -> str:
    if not isinstance(value, str):
        raise EngineError("BAD_SHAPE", f"{where}.{field} must be a string")
    return value


def _require_int(value: Any, field: str, where: str) -> int:
    # bool is a subclass of int; a duration of `true` is a bug, not a duration.
    if isinstance(value, bool) or not isinstance(value, int):
        raise EngineError("BAD_SHAPE", f"{where}.{field} must be an integer")
    return value


def _field(raw: dict[str, Any], snake: str, camel: str, default: Any = _MISSING) -> Any:
    """Read a field that may arrive in either casing.

    The engine's own vocabulary is snake_case, because it mirrors the storage format. Callers
    arrive with JavaScript-shaped camelCase, and normalising that at the boundary — once, here
    — beats every surface inventing its own coercion. Both languages do this identically.
    """
    if snake in raw:
        return raw[snake]
    if camel in raw:
        return raw[camel]
    if default is _MISSING:
        return None
    return default


def parse_trace(value: Any, field: str = "trace") -> Trace:
    """Validate an untrusted trace into a `Trace`, or raise EngineError with a stable code.

    Accepts snake_case (`trace_id`, `span_id`, `parent_id`, `start_ns`, `dur_ns`) and the
    camelCase equivalents. Every rejection names the offending field. A malformed recording
    must fail loudly at the boundary rather than silently diff into a plausible-looking wrong
    answer.
    """
    if not isinstance(value, dict):
        raise EngineError("BAD_SHAPE", f"{field} must be an object")

    trace_id = _require_str(_field(value, "trace_id", "traceId"), "trace_id", field)
    label = _require_str(_field(value, "label", "label", ""), "label", field)
    raw_spans = _field(value, "spans", "spans")
    if not isinstance(raw_spans, list):
        raise EngineError("BAD_SHAPE", f"{field}.spans must be an array")

    spans: list[Span] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_spans):
        where = f"{field}.spans[{index}]"
        if not isinstance(raw, dict):
            raise EngineError("BAD_SHAPE", f"{where} must be an object")
        span_id = _require_str(_field(raw, "span_id", "spanId"), "span_id", where)
        if span_id == "":
            raise EngineError("BAD_SHAPE", f"{where}.span_id must not be empty")
        if span_id in seen:
            raise EngineError("DUPLICATE_SPAN_ID", f"{where}.span_id {span_id!r} appears twice")
        seen.add(span_id)

        parent = _field(raw, "parent_id", "parentId")
        if parent is not None:
            parent = _require_str(parent, "parent_id", where)

        name = _require_str(_field(raw, "name", "name"), "name", where)
        start_ns = _require_int(_field(raw, "start_ns", "startNs"), "start_ns", where)
        dur_ns = _require_int(_field(raw, "dur_ns", "durNs"), "dur_ns", where)
        if start_ns < 0:
            raise EngineError("NEGATIVE_VALUE", f"{where}.start_ns must not be negative")
        if dur_ns < 0:
            raise EngineError("NEGATIVE_VALUE", f"{where}.dur_ns must not be negative")

        spans.append(
            {
                "span_id": span_id,
                "parent_id": parent,
                "name": name,
                "start_ns": start_ns,
                "dur_ns": dur_ns,
            }
        )

    return {"trace_id": trace_id, "label": label, "spans": spans}


def require_field(payload: Any, field: str) -> Any:
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "input must be an object")
    if field not in payload:
        raise EngineError("MISSING_FIELD", f"input is missing {field!r}")
    return payload[field]