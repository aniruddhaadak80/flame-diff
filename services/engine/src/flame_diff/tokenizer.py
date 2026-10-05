"""The tokenizer.

The product's central claim is that a comparison can be proved faithful. That claim rests on
this function, so its contract is stated exactly:

    detokenize(tokenize(s)) == s        for every string s

Byte for byte, unconditionally — not "for canonical input", not "modulo whitespace".
Whitespace is itself a token, which is what buys the unconditional version: concatenating
the `text` of every token reproduces the input, because the tokens partition it.

`start` and `end` are half-open character offsets. Because `escape` forces the canonical
form to pure ASCII, they are also byte offsets and UTF-16 code-unit offsets, so the Python
and TypeScript implementations index identically.

The lexer is strict. It accepts exactly the grammar the canonical renderer emits and raises
on anything else, so a malformed recording fails at the boundary instead of diffing into a
plausible-looking wrong answer.

The differ does NOT diff whitespace — it filters to significant tokens first (see
`significant`). Losing the round trip to gain a readable diff would be the wrong trade, so
the lossless stream is kept intact and the noisy part is dropped at use time.
"""

from __future__ import annotations

from typing import Final

from .model import Token
from .protocol import EngineError

KIND_WS: Final[str] = "ws"
KIND_LPAREN: Final[str] = "lparen"
KIND_RPAREN: Final[str] = "rparen"
KIND_SYM: Final[str] = "sym"
KIND_STRING: Final[str] = "string"
KIND_NUMBER: Final[str] = "number"

#: Token kinds that carry meaning. Whitespace is deliberately absent.
SIGNIFICANT_KINDS: Final[frozenset[str]] = frozenset(
    {KIND_LPAREN, KIND_RPAREN, KIND_SYM, KIND_STRING, KIND_NUMBER}
)

_WHITESPACE: Final[str] = " \t\r\n"
_SYMBOL_BODY: Final[str] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
_DIGITS: Final[str] = "0123456789"


def tokenize(text: str) -> list[Token]:
    """Split `text` into typed tokens with byte-exact half-open [start, end) offsets."""
    tokens: list[Token] = []
    index = 0
    length = len(text)

    while index < length:
        character = text[index]

        if character in _WHITESPACE:
            end = index + 1
            while end < length and text[end] in _WHITESPACE:
                end += 1
            tokens.append({"kind": KIND_WS, "text": text[index:end], "start": index, "end": end})
            index = end
            continue

        if character == "(":
            tokens.append({"kind": KIND_LPAREN, "text": "(", "start": index, "end": index + 1})
            index += 1
            continue

        if character == ")":
            tokens.append({"kind": KIND_RPAREN, "text": ")", "start": index, "end": index + 1})
            index += 1
            continue

        if character == '"':
            end = index + 1
            closed = False
            while end < length:
                if text[end] == "\\":
                    end += 2
                    continue
                if text[end] == '"':
                    end += 1
                    closed = True
                    break
                end += 1
            if not closed:
                raise EngineError("UNTERMINATED_STRING", f"unterminated string at offset {index}")
            if end > length:
                raise EngineError("UNTERMINATED_STRING", f"unterminated escape at offset {index}")
            tokens.append(
                {"kind": KIND_STRING, "text": text[index:end], "start": index, "end": end}
            )
            index = end
            continue

        if character in _DIGITS or (character == "-" and index + 1 < length and text[index + 1] in _DIGITS):
            end = index + 1
            while end < length and text[end] in _DIGITS:
                end += 1
            tokens.append(
                {"kind": KIND_NUMBER, "text": text[index:end], "start": index, "end": end}
            )
            index = end
            continue

        if character in _SYMBOL_BODY:
            end = index + 1
            while end < length and text[end] in _SYMBOL_BODY:
                end += 1
            tokens.append({"kind": KIND_SYM, "text": text[index:end], "start": index, "end": end})
            index = end
            continue

        raise EngineError(
            "UNEXPECTED_CHARACTER",
            f"unexpected character {character!r} at offset {index}",
        )

    return tokens


def detokenize(tokens: list[Token]) -> str:
    """Reassemble the source text. The exact inverse of `tokenize`."""
    return "".join(token["text"] for token in tokens)


def significant(tokens: list[Token]) -> list[Token]:
    """Drop whitespace tokens. What the differ actually compares."""
    return [token for token in tokens if token["kind"] in SIGNIFICANT_KINDS]


def verify_roundtrip(text: str) -> dict[str, object]:
    """The faithfulness probe: does the text survive its own token stream?"""
    tokens = tokenize(text)
    rebuilt = detokenize(tokens)
    return {
        "lossless": rebuilt == text,
        "token_count": len(tokens),
        "significant_count": len(significant(tokens)),
        "byte_length": len(text.encode("utf-8")),
        "rebuilt_byte_length": len(rebuilt.encode("utf-8")),
    }