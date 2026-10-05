from __future__ import annotations

import pytest

from flame_diff.protocol import EngineError
from flame_diff.tokenizer import (
    detokenize,
    significant,
    tokenize,
    verify_roundtrip,
)


class TestRoundTrip:
    @pytest.mark.parametrize(
        "text",
        [
            "",
            " ",
            "(trace \"t\" \"l\" 0)",
            "(span \"a\" \"b\" 0 1\n  (span \"c\" \"d\" 2 3\n  )\n)",
            "no tokens at all",
            "tabs\tand\nnewlines\r\n",
            '"escapes \\" \\\\ \\n \\u00e9"',
            "-42",
        ],
    )
    def test_detokenize_is_the_exact_inverse(self, text: str) -> None:
        assert detokenize(tokenize(text)) == text

    def test_offsets_are_half_open_and_contiguous(self) -> None:
        text = '(span "a" 0 1)'
        tokens = tokenize(text)
        assert tokens[0]["start"] == 0
        for index, token in enumerate(tokens):
            assert text[token["start"] : token["end"]] == token["text"]
            if index + 1 < len(tokens):
                assert token["end"] == tokens[index + 1]["start"]

    def test_verify_roundtrip_reports_the_verdict(self) -> None:
        probe = verify_roundtrip('(span "a" 0 1)')
        assert probe["lossless"] is True
        assert probe["byte_length"] == len('(span "a" 0 1)'.encode())


class TestTokenKinds:
    def test_each_kind_is_recognised(self) -> None:
        kinds = [token["kind"] for token in tokenize('( sym "str" -7 \n)')]
        assert kinds == ["lparen", "ws", "sym", "ws", "string", "ws", "number", "ws", "rparen"]

    def test_significant_drops_only_whitespace(self) -> None:
        tokens = significant(tokenize("( a \n b )"))
        assert [token["text"] for token in tokens] == ["(", "a", "b", ")"]


class TestStrictness:
    @pytest.mark.parametrize("text", ["@", "#", "a@b", "'single'", "%"])
    def test_rejects_characters_outside_the_grammar(self, text: str) -> None:
        with pytest.raises(EngineError) as caught:
            tokenize(text)
        assert caught.value.code == "UNEXPECTED_CHARACTER"

    def test_rejects_an_unterminated_string(self) -> None:
        with pytest.raises(EngineError) as caught:
            tokenize('(span "never closed')
        assert caught.value.code == "UNTERMINATED_STRING"

    def test_a_string_escape_at_the_very_end_is_unterminated(self) -> None:
        with pytest.raises(EngineError):
            tokenize('"abc\\')