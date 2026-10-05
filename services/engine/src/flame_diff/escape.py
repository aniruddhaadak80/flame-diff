"""String escaping, shared by the canonical renderer and the columnar codec.

One implementation, used by both, so a value that survives a round trip through the
canonical form survives the columnar form too. The escaped form contains no whitespace and
no unescaped quote, which is what lets the columnar container stay line-oriented.

Everything outside printable ASCII is escaped as \\uXXXX. That is not cosmetic: it makes
the canonical form pure ASCII, so a token offset means the same thing to Python (code
points) and to TypeScript (UTF-16 units). Without this, one astral character in a span name
would make the two implementations disagree about every offset after it, and the
cross-language golden test would fail for a reason that has nothing to do with the engine.
"""

from __future__ import annotations

from .protocol import EngineError

_SIMPLE_ESCAPES: dict[str, str] = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}

_HEX = "0123456789abcdef"


def escape(value: str) -> str:
    """Return `value` wrapped in quotes, ASCII-safe and whitespace-free."""
    out: list[str] = ['"']
    for character in value:
        simple = _SIMPLE_ESCAPES.get(character)
        if simple is not None:
            out.append(simple)
            continue
        point = ord(character)
        if 0x20 <= point <= 0x7E:
            out.append(character)
            continue
        out.append("\\u")
        out.append(_HEX[(point >> 12) & 0xF])
        out.append(_HEX[(point >> 8) & 0xF])
        out.append(_HEX[(point >> 4) & 0xF])
        out.append(_HEX[point & 0xF])
    out.append('"')
    return "".join(out)


def unescape(token: str) -> str:
    """Inverse of `escape`. Raises on an unterminated string, a dangling escape, or a
    malformed \\uXXXX."""
    if len(token) < 2 or token[0] != '"' or token[-1] != '"':
        raise EngineError("BAD_TOKEN", f"expected a quoted string, got {token!r}")

    out: list[str] = []
    index = 1
    end = len(token) - 1
    while index < end:
        character = token[index]
        if character != "\\":
            if character == '"':
                raise EngineError("BAD_TOKEN", f"unescaped quote inside {token!r}")
            out.append(character)
            index += 1
            continue

        index += 1
        if index >= end:
            raise EngineError("BAD_TOKEN", f"dangling escape in {token!r}")
        following = token[index]
        simple = {"\\": "\\", '"': '"', "n": "\n", "r": "\r", "t": "\t"}.get(following)
        if simple is not None:
            out.append(simple)
            index += 1
            continue
        if following != "u":
            raise EngineError("BAD_TOKEN", f"unknown escape \\{following} in {token!r}")
        digits = token[index + 1 : index + 5]
        if len(digits) != 4 or any(digit not in _HEX for digit in digits):
            raise EngineError("BAD_TOKEN", f"malformed \\u escape in {token!r}")
        point = int(digits, 16)
        if point >= 0xD800 and point <= 0xDFFF:
            raise EngineError("BAD_TOKEN", f"lone surrogate escape in {token!r}")
        if point > 0x10FFFF:
            raise EngineError("BAD_TOKEN", f"escape out of range in {token!r}")
        out.append(chr(point))
        index += 5

    return "".join(out)