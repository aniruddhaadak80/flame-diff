from __future__ import annotations

import pytest

from flame_diff.escape import escape, unescape
from flame_diff.protocol import EngineError


class TestEscape:
    def test_plain_text_is_wrapped_only(self) -> None:
        assert escape("db.query") == '"db.query"'

    def test_metacharacters(self) -> None:
        assert escape('a"b') == '"a\\"b"'
        assert escape("a\\b") == '"a\\\\b"'
        assert escape("a\nb") == '"a\\nb"'
        assert escape("a\tb") == '"a\\tb"'
        assert escape("a\rb") == '"a\\rb"'

    def test_non_ascii_becomes_ascii(self) -> None:
        # Forced to ASCII so token offsets mean the same thing in Python and TypeScript.
        assert escape("café") == '"caf\\u00e9"'
        assert escape("日本") == '"\\u65e5\\u672c"'

    def test_roundtrips_every_case(self) -> None:
        for value in ['plain', 'a"b', "a\\b", "a\nb", "café", "", "  spaced  ", "()"]:
            assert unescape(escape(value)) == value

    def test_empty_string(self) -> None:
        assert escape("") == '""'
        assert unescape('""') == ""

    @pytest.mark.parametrize(
        "token",
        ['"unterminated', "not quoted", '"dangling\\"', '"bad \\q escape"', '"\\u12"', '"\\uZZZZ"'],
    )
    def test_rejects_malformed_tokens(self, token: str) -> None:
        with pytest.raises(EngineError) as caught:
            unescape(token)
        assert caught.value.code in {"BAD_TOKEN", "UNTERMINATED_STRING"}

    def test_rejects_a_lone_surrogate_escape(self) -> None:
        with pytest.raises(EngineError):
            unescape('"\\ud800"')