from __future__ import annotations

import random

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from flame_diff.edit import (
    OP_DELETE,
    OP_EQUAL,
    OP_INSERT,
    edit_cost,
    edit_ops,
    edit_script,
    hunks,
)
from flame_diff.tokenizer import significant, tokenize


def lcs_length(a: list[str], b: list[str]) -> int:
    """The brute-force optimum. The oracle the minimality claim is measured against."""
    previous = [0] * (len(b) + 1)
    for index_a in range(1, len(a) + 1):
        current = [0] * (len(b) + 1)
        for index_b in range(1, len(b) + 1):
            if a[index_a - 1] == b[index_b - 1]:
                current[index_b] = previous[index_b - 1] + 1
            else:
                current[index_b] = max(previous[index_b], current[index_b - 1])
        previous = current
    return previous[len(b)]


def assert_valid_alignment(a: list[str], b: list[str], steps: list[tuple[str, int, int]]) -> None:
    """Replaying the script must consume both sequences exactly, in order."""
    index_a = index_b = 0
    for op, position_a, position_b in steps:
        if op == OP_EQUAL:
            assert position_a == index_a
            assert position_b == index_b
            assert a[index_a] == b[index_b]
            index_a += 1
            index_b += 1
        elif op == OP_DELETE:
            assert position_a == index_a
            index_a += 1
        else:
            assert position_b == index_b
            index_b += 1
    assert index_a == len(a)
    assert index_b == len(b)


class TestMinimality:
    """Minimality is checked against an independent oracle, never against itself."""

    @pytest.mark.parametrize(
        ("left", "right"),
        [
            ([], []),
            ([], ["a"]),
            (["a"], []),
            (["a", "a", "a"], ["a", "a", "a"]),
            (list("abcdefghij"), list("jihgfedcba")),
            (list("abcabcabc"), list("abc")),
            (list("a" * 40 + "b" * 40), list("b" * 40 + "a" * 40)),
            (list("xy"), list("yx")),
        ],
    )
    def test_structured_cases_are_minimal(self, left: list[str], right: list[str]) -> None:
        steps = edit_ops(left, right)
        assert edit_cost(steps) == len(left) + len(right) - 2 * lcs_length(left, right)
        assert_valid_alignment(left, right, steps)

    @pytest.mark.property
    @settings(max_examples=400, deadline=None)
    @given(
        st.lists(st.sampled_from(["a", "b", "c"]), max_size=18),
        st.lists(st.sampled_from(["a", "b", "c"]), max_size=18),
    )
    def test_random_pairs_match_the_oracle(
        self, left: list[str], right: list[str]
    ) -> None:
        steps = edit_ops(left, right)
        assert edit_cost(steps) == len(left) + len(right) - 2 * lcs_length(left, right)
        assert_valid_alignment(left, right, steps)


class TestDeterminism:
    @pytest.mark.property
    @settings(max_examples=200, deadline=None)
    @given(
        st.lists(st.sampled_from(["a", "b", "c", "d"]), max_size=20),
        st.lists(st.sampled_from(["a", "b", "c", "d"]), max_size=20),
    )
    def test_the_same_pair_always_yields_the_same_script(
        self, left: list[str], right: list[str]
    ) -> None:
        assert edit_ops(left, right) == edit_ops(left, right)

    def test_ties_resolve_the_same_way_every_time(self) -> None:
        # Two maximal-shift candidates exist here; the deletion-first rule must pick one.
        left, right = ["a", "b", "c"], ["b", "c"]
        assert edit_ops(left, right) == edit_ops(left, right)


class TestHunks:
    def test_identical_input_is_one_equal_hunk(self) -> None:
        script = edit_script(significant(tokenize("(a)")), significant(tokenize("(a)")))
        assert [hunk["op"] for hunk in script] == [OP_EQUAL]
        assert script[0]["base_len"] == script[0]["head_len"]

    def test_empty_against_content(self) -> None:
        script = edit_script([], significant(tokenize("a")))
        assert [hunk["op"] for hunk in script] == [OP_INSERT]
        assert script[0]["tokens"] == ["a"]

    def test_content_against_empty(self) -> None:
        script = edit_script(significant(tokenize("(a)")), [])
        assert [hunk["op"] for hunk in script] == [OP_DELETE]

    def test_hunks_partition_the_sequences(self) -> None:
        random.seed(11)
        alphabet = ["(", ")", "a", "b"]
        for _ in range(200):
            left = [random.choice(alphabet) for _ in range(random.randint(0, 12))]
            right = [random.choice(alphabet) for _ in range(random.randint(0, 12))]
            steps = edit_ops(left, right)
            grouped = hunks(left, right, steps)
            assert_valid_alignment(left, right, steps)
            assert sum(h["base_len"] for h in grouped) == len(left)
            assert sum(h["head_len"] for h in grouped) == len(right)

    def test_whitespace_is_not_diffed(self) -> None:
        spaced = significant(tokenize("( a\n b )"))
        tight = significant(tokenize("(a b)"))
        assert edit_cost(edit_ops([t["text"] for t in spaced], [t["text"] for t in tight])) == 0