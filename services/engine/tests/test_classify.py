from __future__ import annotations

from flame_diff.classify import (
    STATUS_ADDED,
    STATUS_DEPTH_SHIFTED,
    STATUS_DURATION_CHANGED,
    STATUS_IMPROVED,
    STATUS_REGRESSED,
    STATUS_REMOVED,
    STATUS_RENAMED,
    STATUS_REORDERED,
    STATUS_UNCHANGED,
    classify,
)
from flame_diff.deltas import column_deltas
from flame_diff.model import Trace, parse_trace


def span(span_id: str, name: str, start: int, dur: int, parent: str | None = None) -> dict:
    return {"span_id": span_id, "parent_id": parent, "name": name, "start_ns": start, "dur_ns": dur}


def trace(spans: list[dict], label: str = "run") -> Trace:
    return parse_trace({"trace_id": "t", "label": label, "spans": spans})


def by_id(rows: list[dict]) -> dict[str, dict]:
    return {row["span_id"]: row for row in rows}


BASE = [
    span("r", "handle", 0, 1000),
    span("a", "cache", 10, 100, "r"),
    span("b", "db", 20, 500, "r"),
]


class TestStatusDetection:
    def test_an_identical_pair_is_all_unchanged(self) -> None:
        rows, stats = classify(trace(BASE), trace(list(reversed(BASE))))
        assert stats["unchanged"] == 3
        assert all(row["status"] == STATUS_UNCHANGED for row in rows)

    def test_a_new_span_is_added(self) -> None:
        head = [*BASE, span("c", "retry", 900, 10, "r")]
        rows, stats = classify(trace(BASE), trace(head))
        assert stats["added"] == 1
        row = by_id(rows)["c"]
        assert row["status"] == STATUS_ADDED
        assert row["base_dur_ns"] is None
        assert row["head_dur_ns"] == 10

    def test_a_dropped_span_is_removed_and_keeps_its_base_duration(self) -> None:
        head = [BASE[0], BASE[1]]
        rows, stats = classify(trace(BASE), trace(head))
        assert stats["removed"] == 1
        row = by_id(rows)["b"]
        assert row["status"] == STATUS_REMOVED
        assert row["base_dur_ns"] == 500
        assert row["head_dur_ns"] is None

    def test_a_rename_is_a_rename_not_a_delete_plus_add(self) -> None:
        head = [BASE[0], span("a", "cache.v2", 10, 100, "r"), BASE[2]]
        rows, stats = classify(trace(BASE), trace(head))
        assert stats["renamed"] == 1
        assert stats["added"] == 0 and stats["removed"] == 0
        assert by_id(rows)["a"]["flags"] == [STATUS_RENAMED, STATUS_UNCHANGED]

    def test_a_doubling_is_a_regression(self) -> None:
        head = [BASE[0], span("a", "cache", 10, 300, "r"), BASE[2]]
        _, stats = classify(trace(BASE), trace(head), regression_ratio=1.25)
        assert stats["duration_regressed"] == 1
        assert by_id(classify(trace(BASE), trace(head))[0])["a"]["delta_bps"] == 20_000

    def test_a_halving_is_an_improvement(self) -> None:
        head = [BASE[0], span("a", "cache", 10, 50, "r"), BASE[2]]
        _, stats = classify(trace(BASE), trace(head), regression_ratio=1.25)
        assert stats["duration_improved"] == 1

    def test_a_small_change_is_not_called_a_regression(self) -> None:
        head = [BASE[0], span("a", "cache", 10, 105, "r"), BASE[2]]
        _, stats = classify(trace(BASE), trace(head), regression_ratio=1.25)
        assert stats["duration_regressed"] == 0
        assert by_id(classify(trace(BASE), trace(head))[0])["a"]["status"] == STATUS_DURATION_CHANGED

    def test_a_reparenting_is_a_depth_shift(self) -> None:
        head = [BASE[0], BASE[2], span("a", "cache", 10, 100, "b")]
        rows, stats = classify(trace(BASE), trace(head))
        assert stats["depth_shifted"] == 1
        row = by_id(rows)["a"]
        assert (row["base_depth"], row["depth"]) == (1, 2)

    def test_a_rename_that_moves_a_span_reports_both_facts(self) -> None:
        # Canonical sibling order is name-primary, so a span only changes position when it
        # is renamed. That is a real and useful signal, but it is a flag, never the status.
        base = [span("r", "handle", 0, 1000), span("a", "aaa", 0, 10, "r"), span("b", "bbb", 0, 10, "r")]
        head = [span("r", "handle", 0, 1000), span("a", "zzz", 0, 10, "r"), span("b", "bbb", 0, 10, "r")]
        row = by_id(classify(trace(base), trace(head))[0])["a"]
        assert row["status"] == STATUS_RENAMED
        assert STATUS_REORDERED in row["flags"]
        _, stats = classify(trace(base), trace(head))
        # Both spans moved: the renamed one crossed 'bbb', and 'bbb' yielded its place.
        # Flagging both is symmetric and accurate, so the count is 2 and not 1.
        assert stats["reordered"] == 2

    def test_min_duration_suppresses_trivial_jitter(self) -> None:
        head = [BASE[0], span("a", "cache", 10, 101, "r"), BASE[2]]
        _, stats = classify(trace(BASE), trace(head), min_duration_ns=1000)
        assert stats["unchanged"] == 3

    def test_every_applicable_flag_is_kept(self) -> None:
        head = [BASE[0], span("a", "cache.v2", 900, 900, "b"), BASE[2]]
        row = by_id(classify(trace(BASE), trace(head))[0])["a"]
        assert set(row["flags"]) == {STATUS_RENAMED, STATUS_DEPTH_SHIFTED, STATUS_REGRESSED}


class TestBasisPoints:
    """Basis points round toward negative infinity, matching the TypeScript port.

    -600 on 6800 is the exact case the cross-language golden file caught: a truncating
    implementation reports -882, a flooring one reports -883.
    """

    def _probe(self, base: int, head: int) -> int | None:
        rows, _ = classify(
            trace([span("r", "handle", 0, base)]),
            trace([span("r", "handle", 0, head)]),
        )
        return rows[0]["delta_bps"]

    def test_rounds_a_fractional_regression_down(self) -> None:
        assert self._probe(6_800, 7_400) == 882

    def test_rounds_a_fractional_improvement_down_not_toward_zero(self) -> None:
        assert self._probe(6_800, 6_200) == -883

    def test_is_exact_when_the_division_lands_on_a_whole_number(self) -> None:
        assert self._probe(1_000, 2_000) == 10_000
        assert self._probe(1_000, 500) == -5_000

    def test_reports_no_basis_points_when_the_baseline_was_zero(self) -> None:
        assert self._probe(0, 500) is None


class TestTimelineOrder:
    def test_rows_follow_the_head_recording(self) -> None:
        rows, _ = classify(trace(BASE), trace(BASE))
        assert [row["span_id"] for row in rows] == ["r", "a", "b"]

    def test_a_removal_does_not_invent_a_reordering(self) -> None:
        head = [BASE[0], BASE[2], span("c", "late", 900, 1, "r")]
        rows, stats = classify(trace(BASE), trace(head))
        # 'a' is gone from head, but its canonical name sorts before 'b', so it is spliced
        # back in between 'r' and 'b' rather than dumped at the end of the timeline.
        assert [row["span_id"] for row in rows] == ["r", "a", "b", "c"]
        # 'b' did not move relative to the spans it still competes with, so deleting 'a'
        # must not be reported as 'b' being reordered.
        assert stats["reordered"] == 0
        assert [row["status"] for row in rows] == [
            "unchanged",
            "removed",
            "unchanged",
            "added",
        ]


class TestColumnDeltas:
    def test_counts_changes_per_column(self) -> None:
        head = [BASE[0], span("a", "cache", 10, 300, "r"), span("c", "new", 1, 1, "r")]
        deltas = {delta["column"]: delta for delta in column_deltas(trace(BASE), trace(head))}
        # Only 'r' and 'a' are shared, so only those two can register as "changed".
        # 'c' is new and is counted as added on every column, never as a change.
        assert deltas["span_id"]["added"] == 1
        assert deltas["span_id"]["changed"] == 0
        assert deltas["dur_ns"]["changed"] == 1
        assert deltas["name"]["changed"] == 0
        assert deltas["start_ns"]["changed"] == 0

    def test_every_column_is_reported(self) -> None:
        assert len(column_deltas(trace(BASE), trace(BASE))) == 6

    def test_identical_recordings_change_nothing(self) -> None:
        for delta in column_deltas(trace(BASE), trace(BASE)):
            assert delta["changed"] == 0
            assert delta["unchanged"] == 3