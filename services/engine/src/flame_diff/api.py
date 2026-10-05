"""The operation registry — the engine's entire public surface.

One JSON object in, one JSON object out, one named operation per entry point. Each handler
is a pure function: no clock, no network, no filesystem, no randomness. That is what lets
the TypeScript host call this as a function rather than run a server.

The operations, and what each is for:

  canonicalize  the canonical text for one recording
  tokenize      the token stream, and the losslessness verdict for it
  detokenize    reassemble text from tokens — the inverse, and the proof
  edit          the minimal edit script between two token streams
  diff          the flagship: canonicalise both, diff, classify, and report
  columns       per-column deltas between two recordings
  encode        a recording to the FLDC columnar container
  decode        a recording back out of the FLDC container
  health        liveness and version, for `doctor`
"""

from __future__ import annotations

from typing import Any, Final

from . import columns as columns_module
from .canonical import render
from .classify import classify
from .deltas import column_deltas
from .edit import edit_cost, edit_ops, hunks
from .model import Report, Trace, parse_trace, require_field
from .protocol import EngineError
from .tokenizer import (
    significant,
    tokenize as _tokenize,
    verify_roundtrip,
)

_VERSION: Final[str] = "0.1.0"


def _trace_field(payload: Any, field: str) -> Trace:
    return parse_trace(require_field(payload, field), field)


def op_canonicalize(payload: Any) -> dict[str, Any]:
    trace = _trace_field(payload, "trace")
    text, detached = render(trace)
    probe = verify_roundtrip(text)
    return {
        "text": text,
        "byte_length": len(text.encode("utf-8")),
        "span_count": len(trace["spans"]),
        "detached": detached,
        "lossless": probe["lossless"],
        "token_count": probe["token_count"],
        "significant_count": probe["significant_count"],
    }


def op_tokenize(payload: Any) -> dict[str, Any]:
    text = require_field(payload, "text")
    if not isinstance(text, str):
        raise EngineError("BAD_SHAPE", '"text" must be a string')
    probe = verify_roundtrip(text)
    tokens = _tokenize(text)
    if not bool(probe["lossless"]):  # pragma: no cover - a property test guards this
        raise EngineError("ROUNDTRIP_FAILED", "tokenizer did not reproduce its input")
    return {
        "tokens": tokens,
        "lossless": probe["lossless"],
        "token_count": probe["token_count"],
        "significant_count": probe["significant_count"],
        "byte_length": probe["byte_length"],
    }


def op_detokenize(payload: Any) -> dict[str, Any]:
    raw = require_field(payload, "tokens")
    if not isinstance(raw, list):
        raise EngineError("BAD_SHAPE", '"tokens" must be an array')
    texts: list[str] = []
    for index, token in enumerate(raw):
        if not isinstance(token, dict) or not isinstance(token.get("text"), str):
            raise EngineError("BAD_SHAPE", f'tokens[{index}].text must be a string')
        texts.append(str(token["text"]))
    return {"text": "".join(texts)}


def op_edit(payload: Any) -> dict[str, Any]:
    left = _significant_texts(payload, "base")
    right = _significant_texts(payload, "head")
    steps = edit_ops(left, right)
    return {
        "hunks": hunks(left, right, steps),
        "cost": edit_cost(steps),
        "base_tokens": len(left),
        "head_tokens": len(right),
    }


def _significant_texts(payload: Any, field: str) -> list[str]:
    if field not in payload:
        raise EngineError("MISSING_FIELD", f"input is missing {field!r}")
    value = payload[field]
    if isinstance(value, str):
        return [token["text"] for token in significant(_tokenize(value))]
    if not isinstance(value, list):
        raise EngineError("BAD_SHAPE", f'"{field}" must be a string or an array of tokens')
    texts: list[str] = []
    for index, token in enumerate(value):
        if isinstance(token, str):
            texts.append(token)
        elif isinstance(token, dict) and isinstance(token.get("text"), str):
            texts.append(str(token["text"]))
        else:
            raise EngineError("BAD_SHAPE", f'"{field}"[{index}] must be a token')
    return texts


def op_diff(payload: Any) -> Report:
    base = _trace_field(payload, "base")
    head = _trace_field(payload, "head")

    regression_ratio = _ratio(payload, "regression_ratio", 1.25)
    min_duration = _integer(payload, "min_duration_ns", 0)
    max_hunks = _integer(payload, "max_hunks", 5_000)

    base_text, base_detached = render(base)
    head_text, head_detached = render(head)
    base_tokens = significant(_tokenize(base_text))
    head_tokens = significant(_tokenize(head_text))

    steps = edit_ops([t["text"] for t in base_tokens], [t["text"] for t in head_tokens])
    script = hunks(
        [t["text"] for t in base_tokens], [t["text"] for t in head_tokens], steps
    )
    if len(script) > max_hunks:
        script = script[:max_hunks]

    rows, stats = classify(base, head, regression_ratio, min_duration)
    stats["orphans"] = base_detached + head_detached

    base_probe = verify_roundtrip(base_text)
    head_probe = verify_roundtrip(head_text)

    return {
        "base": _summary(base, base_text, base_probe, len(base_tokens)),
        "head": _summary(head, head_text, head_probe, len(head_tokens)),
        "stats": stats,
        "rows": rows,
        "column_deltas": column_deltas(base, head),
        "hunks": script,
        "edit_cost": edit_cost(steps),
        "roundtrip": {
            "base_verified": bool(base_probe["lossless"]),
            "head_verified": bool(head_probe["lossless"]),
            "lossless": bool(base_probe["lossless"]) and bool(head_probe["lossless"]),
        },
    }


def _summary(
    trace: Trace, text: str, probe: dict[str, object], significant_count: int
) -> dict[str, Any]:
    return {
        "trace_id": trace["trace_id"],
        "label": trace["label"],
        "span_count": len(trace["spans"]),
        "byte_length": len(text.encode("utf-8")),
        "token_count": probe["token_count"],
        "significant_count": significant_count,
        "lossless": probe["lossless"],
    }


def op_columns(payload: Any) -> dict[str, Any]:
    base = _trace_field(payload, "base")
    head = _trace_field(payload, "head")
    return {"columns": column_deltas(base, head)}


def op_encode(payload: Any) -> dict[str, Any]:
    trace = _trace_field(payload, "trace")
    text = columns_module.encode(trace)
    return {"text": text, "byte_length": len(text.encode("utf-8"))}


def op_decode(payload: Any) -> dict[str, Any]:
    text = require_field(payload, "text")
    if not isinstance(text, str):
        raise EngineError("BAD_SHAPE", '"text" must be a string')
    return {"trace": columns_module.decode(text)}


def op_health(payload: Any) -> dict[str, Any]:
    _ = payload
    return {
        "ok": True,
        "engine": "flame_diff",
        "version": _VERSION,
        "pure": True,
        "operations": sorted(OPERATIONS),
    }


def _ratio(payload: Any, field: str, fallback: float) -> float:
    if field not in payload:
        return fallback
    value = payload[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EngineError("BAD_SHAPE", f'"{field}" must be a number')
    number = float(value)
    if number < 1.0:
        raise EngineError("BAD_SHAPE", f'"{field}" must be at least 1.0')
    return number


def _integer(payload: Any, field: str, fallback: int) -> int:
    if field not in payload:
        return fallback
    value = payload[field]
    if isinstance(value, bool) or not isinstance(value, int):
        raise EngineError("BAD_SHAPE", f'"{field}" must be an integer')
    if value < 0:
        raise EngineError("BAD_SHAPE", f'"{field}" must not be negative')
    return value


OPERATIONS: Final[dict[str, Any]] = {
    "canonicalize": op_canonicalize,
    "columns": op_columns,
    "decode": op_decode,
    "detokenize": op_detokenize,
    "diff": op_diff,
    "edit": op_edit,
    "encode": op_encode,
    "health": op_health,
    "tokenize": op_tokenize,
}


def analyse(op: str, payload: Any) -> Any:
    handler = OPERATIONS.get(op)
    if handler is None:
        known = ", ".join(sorted(OPERATIONS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)