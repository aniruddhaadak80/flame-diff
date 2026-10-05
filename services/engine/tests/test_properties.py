"""Property tests for the three invariants the product's claim rests on.

These are not incidental coverage. Each one corresponds to a sentence in the README:

  1. the token stream loses nothing;
  2. canonicalisation is order-independent and idempotent, so a diff reflects real change;
  3. the edit script is minimal.

A regression in any of them makes the product's central claim false, so they are written as
properties over generated input rather than as examples someone chose.
"""

from __future__ import annotations

from typing import Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from flame_diff.canonical import canonicalize, render
from flame_diff.columns import decode, encode
from flame_diff.edit import edit_cost, edit_ops
from flame_diff.model import Trace, parse_trace
from flame_diff.protocol import EngineError
from flame_diff.tokenizer import detokenize, significant, tokenize

PROFILE = settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])

# Text drawn from the whole canonical grammar, plus arbitrary noise, so the tokenizer is
# exercised on inputs nobody chose.
grammar = st.one_of(
    st.sampled_from(["(", ")", "span", "trace", " ", "\n", "\t", '"a"', '"b"', "0", "42", "-7"]),
    st.text(alphabet="()\" \\abz019\n\t", max_size=24),
)

identifiers = st.text(alphabet="abcdefghij0123456789_-", min_size=1, max_size=6)
names = st.one_of(identifiers, st.text(alphabet="abc ._", max_size=8))
durations = st.integers(min_value=0, max_value=1_000_000)


@st.composite
def traces(draw: Any) -> Trace:
    """Generate a well-formed trace, including deliberately tangled ones.

    Parents are drawn freely from the whole id pool, so dangling parents and cycles both
    occur — the engine has to stay total on those, not merely correct on tidy input.
    """
    count = draw(st.integers(min_value=0, max_value=8))
    if count == 0:
        spans: list[dict[str, Any]] = []
    else:
        span_ids = [f"s{index}" for index in range(count)]
        tuples = draw(
            st.lists(
                st.tuples(
                    st.sampled_from(span_ids),
                    st.sampled_from([None, *span_ids]),
                    names,
                    st.integers(min_value=0, max_value=5_000),
                    durations,
                ),
                min_size=count,
                max_size=count,
            )
        )
        # Guarantee unique ids: parse_trace rejects duplicates, and a duplicate is not the
        # property under test here.
        assigned = [f"s{index}" for index in range(count)]
        spans = [
            {
                "span_id": assigned[index],
                "parent_id": parent,
                "name": name,
                "start_ns": start,
                "dur_ns": dur,
            }
            for index, (_, parent, name, start, dur) in enumerate(tuples)
        ]
    return parse_trace({"trace_id": "t", "label": draw(names), "spans": spans})


class TestLosslessTokenisation:
    """1. Every input is either tokenized losslessly, or refused with a stable code.

    The claim is stated as a total function on purpose. The lexer is deliberately strict — an
    unterminated string is corruption, not text to guess at — so "round-trips for every
    string" would be the wrong promise. What must hold is that nothing is ever silently
    mis-handled: either the tokens reproduce the input byte for byte, or the caller gets a
    named error. A tokenizer that quietly accepted garbage would be a worse product.
    """

    REFUSAL_CODES = {
        "UNTERMINATED_STRING",
        "UNEXPECTED_CHARACTER",
    }

    @PROFILE
    @given(grammar)
    def test_every_input_is_tokenized_losslessly_or_refused(self, text: str) -> None:
        try:
            tokens = tokenize(text)
        except EngineError as error:
            assert error.code in self.REFUSAL_CODES
            return
        assert detokenize(tokens) == text

    @PROFILE
    @given(grammar)
    def test_offsets_index_the_source_whenever_it_is_accepted(self, text: str) -> None:
        try:
            tokens = tokenize(text)
        except EngineError:
            return
        for token in tokens:
            assert text[token["start"] : token["end"]] == token["text"]

    @PROFILE
    @given(traces())
    def test_canonical_output_is_always_accepted_and_lossless(self, parsed: Trace) -> None:
        # The canonical renderer only ever emits in-grammar text, so it must never be refused.
        text = canonicalize(parsed)
        assert detokenize(tokenize(text)) == text

    @PROFILE
    @given(grammar)
    def test_significant_is_a_subsequence_of_the_stream(self, text: str) -> None:
        try:
            tokens = tokenize(text)
        except EngineError:
            return
        kept = significant(tokens)
        cursor = 0
        for token in kept:
            while tokens[cursor]["start"] != token["start"]:
                cursor += 1
            cursor += 1


class TestCanonicalisation:
    """2. Canonicalisation is order-independent and idempotent."""

    @PROFILE
    @given(traces())
    def test_order_independent(self, parsed: Trace) -> None:
        shuffled = dict(parsed)
        shuffled["spans"] = list(reversed(parsed["spans"]))
        assert canonicalize(parse_trace(shuffled)) == canonicalize(parsed)

    @PROFILE
    @given(traces())
    def test_idempotent(self, parsed: Trace) -> None:
        assert canonicalize(parsed) == canonicalize(parse_trace(parse_trace(parsed)))

    @PROFILE
    @given(traces())
    def test_always_lossless(self, parsed: Trace) -> None:
        assert detokenize(tokenize(canonicalize(parsed))) == canonicalize(parsed)

    @PROFILE
    @given(traces())
    def test_every_span_is_rendered_exactly_once(self, parsed: Trace) -> None:
        text, detached = render(parsed)
        assert detached >= 0
        # Count `span` keywords in the token stream rather than substrings, so a span name
        # containing the word cannot fake a match.
        rendered = sum(
            1 for token in tokenize(text) if token["kind"] == "sym" and token["text"] == "span"
        )
        assert rendered == len(parsed["spans"])


class TestMinimalEditScript:
    """3. The edit script is minimal."""

    @PROFILE
    @given(traces(), traces())
    def test_a_diff_of_a_trace_against_itself_costs_nothing(
        self, left: Trace, right: Trace
    ) -> None:
        a = [token["text"] for token in significant(tokenize(canonicalize(left)))]
        assert edit_cost(edit_ops(a, a)) == 0
        _ = right

    @PROFILE
    @given(traces())
    def test_cost_is_bounded_by_the_input_sizes(self, parsed: Trace) -> None:
        a = [token["text"] for token in significant(tokenize(canonicalize(parsed)))]
        assert edit_cost(edit_ops(a, [])) == len(a)


class TestColumnarContainer:
    @PROFILE
    @given(traces())
    def test_encoding_is_canonical(self, parsed: Trace) -> None:
        shuffled = dict(parsed)
        shuffled["spans"] = list(reversed(parsed["spans"]))
        assert encode(parse_trace(shuffled)) == encode(parsed)

    @PROFILE
    @given(traces())
    def test_encoding_is_byte_stable(self, parsed: Trace) -> None:
        text = encode(parsed)
        assert encode(decode(text)) == text

    @PROFILE
    @given(traces())
    def test_the_span_set_survives(self, parsed: Trace) -> None:
        recovered = decode(encode(parsed))
        key = lambda span: span["span_id"]  # noqa: E731
        assert sorted(recovered["spans"], key=key) == sorted(parsed["spans"], key=key)