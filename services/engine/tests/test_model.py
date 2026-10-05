from __future__ import annotations

import pytest

from flame_diff.model import parse_trace
from flame_diff.protocol import EngineError

SNAKE = {
    "trace_id": "t",
    "label": "run",
    "spans": [
        {
            "span_id": "a",
            "parent_id": None,
            "name": "x",
            "start_ns": 0,
            "dur_ns": 5,
        }
    ],
}

CAMEL = {
    "traceId": "t",
    "label": "run",
    "spans": [{"spanId": "a", "parentId": None, "name": "x", "startNs": 0, "durNs": 5}],
}


class TestCasing:
    """Both casings are accepted, and they are the SAME trace.

    The engine's vocabulary is snake_case because it mirrors the storage format, but callers
    arrive from JavaScript. Normalising at the boundary means the HTTP API, the CLI and the
    MCP server cannot each invent their own coercion — which is exactly how a TypeScript port
    and a Python reference end up disagreeing about what a request means.
    """

    def test_camel_case_parses_to_the_same_trace(self) -> None:
        assert parse_trace(CAMEL) == parse_trace(SNAKE)

    def test_snake_case_still_works(self) -> None:
        assert parse_trace(SNAKE)["trace_id"] == "t"

    def test_a_missing_label_defaults_to_empty(self) -> None:
        payload = {**SNAKE}
        del payload["label"]
        assert parse_trace(payload)["label"] == ""

    def test_snake_case_wins_when_both_are_present(self) -> None:
        payload = {**SNAKE, "traceId": "ignored"}
        assert parse_trace(payload)["trace_id"] == "t"


class TestRejection:
    @pytest.mark.parametrize(
        ("payload", "code"),
        [
            ({"spans": []}, "BAD_SHAPE"),
            ({"trace_id": "t", "spans": "nope"}, "BAD_SHAPE"),
            ({"trace_id": 7, "spans": []}, "BAD_SHAPE"),
            ({"trace_id": "t", "spans": [{}]}, "BAD_SHAPE"),
            ({"trace_id": "t", "spans": [{"span_id": "a", "name": "x", "start_ns": -1, "dur_ns": 0}]}, "NEGATIVE_VALUE"),
            ({"trace_id": "t", "spans": [{"span_id": "a", "name": "x", "start_ns": 0, "dur_ns": -1}]}, "NEGATIVE_VALUE"),
            ({"trace_id": "t", "spans": [{"span_id": "", "name": "x", "start_ns": 0, "dur_ns": 0}]}, "BAD_SHAPE"),
            ({"trace_id": "t", "label": 3, "spans": []}, "BAD_SHAPE"),
            ("not an object", "BAD_SHAPE"),
        ],
    )
    def test_malformed_input_names_the_problem(self, payload: object, code: str) -> None:
        with pytest.raises(EngineError) as caught:
            parse_trace(payload)  # type: ignore[arg-type]
        assert caught.value.code == code

    def test_a_boolean_duration_is_not_a_duration(self) -> None:
        with pytest.raises(EngineError) as caught:
            parse_trace({"trace_id": "t", "spans": [{"span_id": "a", "name": "x", "start_ns": 0, "dur_ns": True}]})
        assert caught.value.code == "BAD_SHAPE"

    def test_duplicate_span_ids_are_refused(self) -> None:
        span = {"span_id": "a", "name": "x", "start_ns": 0, "dur_ns": 1}
        with pytest.raises(EngineError) as caught:
            parse_trace({"trace_id": "t", "spans": [span, dict(span)]})
        assert caught.value.code == "DUPLICATE_SPAN_ID"

    def test_an_explicit_null_parent_is_honoured(self) -> None:
        parsed = parse_trace(
            {"trace_id": "t", "spans": [{"span_id": "a", "parent_id": None, "name": "x", "start_ns": 0, "dur_ns": 1}]}
        )
        assert parsed["spans"][0]["parent_id"] is None