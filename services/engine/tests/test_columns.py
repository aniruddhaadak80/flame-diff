from __future__ import annotations

import pytest

from flame_diff.columns import decode, encode
from flame_diff.model import parse_trace
from flame_diff.protocol import EngineError


def span(span_id: str, name: str, start: int, dur: int, parent: str | None = None) -> dict:
    return {"span_id": span_id, "parent_id": parent, "name": name, "start_ns": start, "dur_ns": dur}


def trace(spans: list[dict], label: str = "run") -> dict:
    return {"trace_id": "t", "label": label, "spans": spans}


SAMPLE = [
    span("r", "http.handle", 0, 12_000),
    span("b", "db.query", 100, 3_000, "r"),
    span("a", "cache.get", 400, 200, "r"),
]


class TestContainer:
    def test_layout(self) -> None:
        # Cells are tab-separated: escape() guarantees a raw tab cannot occur inside a
        # quoted string, which is what keeps a name containing spaces unambiguous.
        assert encode(parse_trace(trace(SAMPLE))) == (
            "FLDC1\n"
            'trace "t"\n'
            'label "run"\n'
            "spans 3\n"
            "columns 6\n"
            "span_id str 3\n"
            '"r"\t"b"\t"a"\n'
            "parent_id str 3\n"
            '""\t"r"\t"r"\n'
            "name str 3\n"
            '"http.handle"\t"db.query"\t"cache.get"\n'
            "start_ns u64 3\n"
            "0\t100\t400\n"
            "dur_ns u64 3\n"
            "12000\t3000\t200\n"
            "depth u64 3\n"
            "0\t1\t1\n"
        )

    def test_rows_are_stored_in_canonical_order(self) -> None:
        assert encode(parse_trace(trace(SAMPLE))) == encode(parse_trace(trace(list(reversed(SAMPLE)))))

    def test_encode_decode_encode_is_byte_stable(self) -> None:
        text = encode(parse_trace(trace(SAMPLE)))
        assert encode(decode(text)) == text

    def test_the_span_set_survives_a_round_trip(self) -> None:
        recovered = decode(encode(parse_trace(trace(SAMPLE))))
        original = parse_trace(trace(SAMPLE))
        assert sorted(recovered["spans"], key=lambda s: s["span_id"]) == sorted(
            original["spans"], key=lambda s: s["span_id"]
        )

    def test_empty_trace(self) -> None:
        text = encode(parse_trace(trace([])))
        assert "spans 0" in text
        assert decode(text)["spans"] == []

    def test_awkward_names_are_escaped(self) -> None:
        text = encode(parse_trace(trace([span("a", 'we "ird"\tname', 0, 1)])))
        assert decode(text)["spans"][0]["name"] == 'we "ird"\tname'

    def test_non_ascii_names_survive(self) -> None:
        text = encode(parse_trace(trace([span("a", "café", 0, 1)])))
        assert "\\u00e9" in text  # ASCII container
        assert decode(text)["spans"][0]["name"] == "café"


class TestCorruption:
    def test_wrong_magic(self) -> None:
        with pytest.raises(EngineError) as caught:
            decode("NOPE\n")
        assert caught.value.code == "BAD_MAGIC"

    def test_truncated_container(self) -> None:
        text = encode(parse_trace(trace(SAMPLE)))
        with pytest.raises(EngineError) as caught:
            decode(text[: len(text) // 2])
        assert caught.value.code in {"TRUNCATED", "BAD_HEADER"}

    def test_row_count_disagrees_with_the_header(self) -> None:
        text = encode(parse_trace(trace(SAMPLE))).replace("span_id str 3", "span_id str 2")
        with pytest.raises(EngineError) as caught:
            decode(text)
        assert caught.value.code == "BAD_ROW"

    def test_unknown_column(self) -> None:
        text = encode(parse_trace(trace(SAMPLE))).replace("span_id str", "surprise str")
        with pytest.raises(EngineError) as caught:
            decode(text)
        assert caught.value.code == "UNKNOWN_COLUMN"

    def test_non_numeric_value_in_a_u64_column(self) -> None:
        text = encode(parse_trace(trace(SAMPLE))).replace(
            "start_ns u64 3\n0\t100\t400", "start_ns u64 3\n0\tx\t400"
        )
        with pytest.raises(EngineError) as caught:
            decode(text)
        assert caught.value.code == "BAD_CELL"

    def test_dangling_parent_is_refused(self) -> None:
        text = encode(parse_trace(trace(SAMPLE))).replace(
            'parent_id str 3\n""\t"r"\t"r"', 'parent_id str 3\n"ghost"\t"r"\t"r"'
        )
        with pytest.raises(EngineError) as caught:
            decode(text)
        assert caught.value.code == "DANGLING_PARENT"

    def test_a_depth_that_contradicts_the_tree_is_refused(self) -> None:
        text = encode(parse_trace(trace(SAMPLE))).replace(
            "depth u64 3\n0\t1\t1", "depth u64 3\n5\t5\t5"
        )
        with pytest.raises(EngineError) as caught:
            decode(text)
        assert caught.value.code == "DEPTH_MISMATCH"

    def test_trailing_data(self) -> None:
        text = encode(parse_trace(trace(SAMPLE))) + "surprise\n"
        with pytest.raises(EngineError) as caught:
            decode(text)
        assert caught.value.code == "TRAILING_DATA"