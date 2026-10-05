#!/usr/bin/env python3
"""Regenerate the cross-language golden fixtures.

    python services/engine/tools/gen_golden.py

The fixtures are the honesty mechanism for this repository. `services/engine` is the
reference implementation; `packages/tracekit` is a TypeScript port that has to run where
Python does not (Vercel has no Python runtime). A port that quietly drifts from its
reference is the classic way a "deterministic core" becomes a lie, so both suites assert the
SAME files this script writes:

  * `services/engine/tests/test_golden.py` — the reference against its own output;
  * `packages/tracekit/src/golden.test.ts` — the port against the same output.

The golden report deliberately contains no floating-point values. `delta_bps` is an integer
in basis points precisely so the two languages cannot disagree over float formatting.

Re-run this only when a deliberate engine behaviour change lands, and review the diff: a
golden change with no corresponding test change is a red flag.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flame_diff.api import analyse
from flame_diff.canonical import canonicalize
from flame_diff.columns import decode, encode
from flame_diff.tokenizer import significant, tokenize

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT = REPO_ROOT / "fixtures" / "golden" / "cases.json"


def span(span_id: str, name: str, start: int, dur: int, parent: str | None = None) -> dict[str, Any]:
    return {"span_id": span_id, "parent_id": parent, "name": name, "start_ns": start, "dur_ns": dur}


BASE_A = [
    span("root", "http.handle", 0, 12_000),
    span("auth", "auth.verify", 120, 900, "root"),
    span("query", "db.query", 1_100, 3_000, "root"),
    span("cache", "cache.get", 4_200, 240, "root"),
    span("render", "view.render", 4_600, 6_800, "root"),
]

HEAD_A = [
    span("root", "http.handle", 0, 14_500),
    span("auth", "auth.verify", 120, 950, "root"),
    span("query", "db.query", 1_100, 6_400, "root"),
    span("cache", "cache.get.v2", 7_600, 90, "root"),
    span("retry", "db.retry", 7_700, 310, "root"),
    span("render", "view.render", 8_000, 6_200, "root"),
]

BASE_B = [
    span("s0", "worker", 0, 5_000),
    span("s1", "parse", 10, 400, "s0"),
    span("s2", "compile", 20, 900, "s0"),
    span("s3", "emit", 30, 120, "s1"),
]

HEAD_B = [
    span("s0", "worker", 0, 5_100),
    span("s1", "parse", 10, 420, "s0"),
    span("s2", "compile", 20, 3_600, "s0"),
]

BASE_C = [
    span("only", 'we "ird" name', 0, 42),
    span("uni", "café", 1, 7, "only"),
]

CASES: list[dict[str, Any]] = [
    {
        "name": "rename-regression-and-addition",
        "base": {"trace_id": "run-a", "label": "before deploy", "spans": BASE_A},
        "head": {"trace_id": "run-a", "label": "after deploy", "spans": HEAD_A},
    },
    {
        "name": "removal-and-depth-shift",
        "base": {"trace_id": "run-b", "label": "baseline", "spans": BASE_B},
        "head": {"trace_id": "run-b", "label": "candidate", "spans": HEAD_B},
    },
    {
        "name": "awkward-names-and-empty",
        "base": {"trace_id": "run-c", "label": "escapes", "spans": BASE_C},
        "head": {"trace_id": "run-c", "label": "escapes", "spans": []},
    },
]


def build_case(case: dict[str, Any]) -> dict[str, Any]:
    base, head = case["base"], case["head"]
    base_text = canonicalize(_validated(base))
    head_text = canonicalize(_validated(head))
    report = analyse("diff", {"base": base, "head": head})
    return {
        "name": case["name"],
        "input": {"base": base, "head": head},
        "expected": {
            "canonical": {"base": base_text, "head": head_text},
            "tokens": {
                "base": tokenize(base_text),
                "head": tokenize(head_text),
            },
            "significantCount": {
                "base": len(significant(tokenize(base_text))),
                "head": len(significant(tokenize(head_text))),
            },
            "report": report,
            "container": {
                "base": encode(_validated(base)),
                "head": encode(_validated(head)),
            },
            "decoded": {"base": decode(encode(_validated(base)))},
        },
    }


def _validated(trace: dict[str, Any]) -> Any:
    from flame_diff.model import parse_trace

    return parse_trace(trace)


def main() -> int:
    payload = {
        "version": 1,
        "generatedBy": "services/engine/tools/gen_golden.py",
        "note": (
            "Asserted by BOTH services/engine/tests/test_golden.py (the reference) and "
            "packages/tracekit/src/golden.test.ts (the TypeScript port). A change here is a "
            "change to the product's observable behaviour, not a formatting fix."
        ),
        "cases": [build_case(case) for case in CASES],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {len(payload['cases'])} case(s) to {OUTPUT}")
    print(f"{OUTPUT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())