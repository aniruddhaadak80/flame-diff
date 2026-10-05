"""The anti-drift test.

Known input, known exact output. This is the test that fails when someone "improves" the
engine and quietly changes what a comparison means, and it is the same file the TypeScript
port asserts against — so if the two implementations ever disagree about a single byte,
exactly one of the two suites goes red.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from flame_diff.api import analyse
from flame_diff.canonical import canonicalize
from flame_diff.columns import decode, encode
from flame_diff.model import parse_trace
from flame_diff.tokenizer import significant, tokenize

GOLDEN = Path(__file__).resolve().parents[3] / "fixtures" / "golden" / "cases.json"


def load_cases() -> list[dict[str, Any]]:
    payload = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert payload["version"] == 1, "unsupported golden fixture version"
    return payload["cases"]


CASES = load_cases()
IDS = [case["name"] for case in CASES]


@pytest.mark.parametrize("case", CASES, ids=IDS)
class TestAgainstGolden:
    def test_canonical_text(self, case: dict[str, Any]) -> None:
        expected = case["expected"]["canonical"]
        assert canonicalize(parse_trace(case["input"]["base"])) == expected["base"]
        assert canonicalize(parse_trace(case["input"]["head"])) == expected["head"]

    def test_token_stream(self, case: dict[str, Any]) -> None:
        expected = case["expected"]["tokens"]
        base_text = case["expected"]["canonical"]["base"]
        head_text = case["expected"]["canonical"]["head"]
        assert tokenize(base_text) == expected["base"]
        assert tokenize(head_text) == expected["head"]

    def test_significant_token_count(self, case: dict[str, Any]) -> None:
        expected = case["expected"]["significantCount"]
        assert len(significant(tokenize(case["expected"]["canonical"]["base"]))) == expected["base"]
        assert len(significant(tokenize(case["expected"]["canonical"]["head"]))) == expected["head"]

    def test_full_report(self, case: dict[str, Any]) -> None:
        assert analyse("diff", case["input"]) == case["expected"]["report"]

    def test_columnar_container(self, case: dict[str, Any]) -> None:
        expected = case["expected"]["container"]
        assert encode(parse_trace(case["input"]["base"])) == expected["base"]
        assert encode(parse_trace(case["input"]["head"])) == expected["head"]

    def test_decoded_container(self, case: dict[str, Any]) -> None:
        decoded = decode(case["expected"]["container"]["base"])
        assert decoded == case["expected"]["decoded"]["base"]


def test_the_fixture_is_not_trivially_empty() -> None:
    # A golden suite that asserts nothing is worse than none: it is a false green.
    assert len(CASES) >= 3
    assert any(case["expected"]["report"]["stats"]["duration_regressed"] for case in CASES)
    assert any(case["expected"]["report"]["stats"]["added"] for case in CASES)
    assert any(case["expected"]["report"]["stats"]["removed"] for case in CASES)
    assert any(case["expected"]["report"]["stats"]["renamed"] for case in CASES)
    assert all(case["expected"]["report"]["roundtrip"]["lossless"] for case in CASES)