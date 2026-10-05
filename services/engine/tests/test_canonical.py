from __future__ import annotations

from flame_diff.canonical import canonicalize, depths_of, order, paths, render
from flame_diff.model import Trace, parse_trace


def span(span_id: str, name: str, start: int, dur: int, parent: str | None = None) -> dict:
    return {"span_id": span_id, "parent_id": parent, "name": name, "start_ns": start, "dur_ns": dur}


def trace(spans: list[dict], trace_id: str = "t", label: str = "run") -> Trace:
    return parse_trace({"trace_id": trace_id, "label": label, "spans": spans})


SAMPLE = [
    span("r", "http.handle", 0, 12_000),
    span("b", "db.query", 100, 3_000, "r"),
    span("a", "cache.get", 400, 200, "r"),
]


class TestRendering:
    def test_nests_the_tree_with_two_space_indents(self) -> None:
        # Children come out in the order they ran: db.query at 100ns, cache.get at 400ns.
        assert canonicalize(trace(SAMPLE)) == (
            '(trace "t" "run" 3)\n'
            '(span "r" "http.handle" 0 12000\n'
            '  (span "b" "db.query" 100 3000\n'
            "  )\n"
            '  (span "a" "cache.get" 400 200\n'
            "  )\n"
            ")\n"
            ")"
        )

    def test_children_are_ordered_by_when_they_ran(self) -> None:
        # Name-primary ordering would render the stack backwards; this is the assertion that
        # keeps the flame graph readable as time.
        rendered = canonicalize(trace(SAMPLE))
        assert rendered.index('"db.query"') < rendered.index('"cache.get"')

    def test_siblings_starting_together_break_the_tie_by_name(self) -> None:
        same = [span("z", "zebra", 5, 1, "r"), span("a", "apple", 5, 1, "r"),
                span("r", "root", 0, 9)]
        assert order(trace(same)) == ["r", "a", "z"]

    def test_siblings_sort_by_name_not_by_input_order(self) -> None:
        assert canonicalize(trace(SAMPLE)) == canonicalize(trace(list(reversed(SAMPLE))))

    def test_empty_trace(self) -> None:
        assert canonicalize(trace([])) == '(trace "t" "run" 0)\n)'

    def test_multiple_roots_are_all_emitted(self) -> None:
        rendered = canonicalize(trace([span("z", "z", 1, 1), span("y", "y", 0, 1)]))
        assert rendered.index('"y"') < rendered.index('"z"')

    def test_names_are_escaped(self) -> None:
        assert 'we\\"ird' in canonicalize(trace([span("a", 'we"ird', 0, 1)]))


class TestDetachedSpans:
    def test_a_missing_parent_becomes_a_root_and_is_counted(self) -> None:
        text, detached = render(trace([span("a", "x", 0, 1), span("b", "y", 0, 1, "ghost")]))
        assert detached == 1
        assert text.count("(span ") == 2

    def test_a_cycle_terminates_and_is_counted(self) -> None:
        # a -> b -> a. A naive recursive walk would never return.
        text, detached = render(trace([span("a", "x", 0, 1, "b"), span("b", "y", 0, 1, "a")]))
        assert detached == 2
        assert text.count("(span ") == 2

    def test_a_self_parent_is_detached(self) -> None:
        _, detached = render(trace([span("a", "x", 0, 1, "a")]))
        assert detached == 1


class TestOrdering:
    def test_preorder_is_path_key_order(self) -> None:
        parsed = trace(SAMPLE)
        assert order(parsed) == ["r", "b", "a"]
        by_id = {s["span_id"]: s for s in parsed["spans"]}
        assert paths(parsed)["b"] == ((0, "http.handle", "r"), (100, "db.query", "b"))
        assert by_id["b"]["parent_id"] == "r"

    def test_depths_come_from_the_tree(self) -> None:
        assert depths_of(trace(SAMPLE)["spans"]) == {"r": 0, "a": 1, "b": 1}

    def test_depth_of_a_deep_chain(self) -> None:
        chain = [span("s0", "f", 0, 1)]
        for level in range(1, 60):
            chain.append(span(f"s{level}", "f", 0, 1, f"s{level - 1}"))
        assert depths_of(trace(chain)["spans"])["s59"] == 59