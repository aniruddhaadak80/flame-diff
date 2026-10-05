#!/usr/bin/env python3
"""Regenerate everything derived from `fixtures/samples/*.json`.

    python scripts/gen-samples.py

The JSON files are the readable source of truth. This script renders them to two places:

  * `fixtures/samples/*.fld` — the columnar FLDC container, via the engine's own codec. This
    is what the CLI reads, so the walkthrough works from a fresh clone with no Python.
  * `apps/web/lib/generated-samples.ts` — a typed module the web app imports.

The second target exists because a serverless function cannot `readFileSync` a path it did
not trace at build time. Generating a module rather than duplicating the data by hand means
the CLI and the deployed web app are provably looking at the same recordings.

Do not edit either generated artefact by hand. Edit the JSON and re-run this.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "engine" / "src"))

from flame_diff.columns import encode  # noqa: E402
from flame_diff.model import parse_trace  # noqa: E402

SAMPLES = REPO_ROOT / "fixtures" / "samples"
WEB_MODULE = REPO_ROOT / "apps" / "web" / "lib" / "generated-samples.ts"

HEADER = """// GENERATED FILE - do not edit.
//
// Produced by `python scripts/gen-samples.py` from `fixtures/samples/*.json`, which is the
// readable source of truth. The web app imports this instead of reading the filesystem,
// because a serverless function cannot read a path it did not trace at build time.
//
// Regenerate after editing any sample JSON.
// `services/engine/tests/test_generated.py` fails if this file drifts from its sources.
"""


def typescript_literal(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False)


def main() -> int:
    sources = sorted(SAMPLES.glob("*.json"))
    if not sources:
        print(f"no sample JSON found in {SAMPLES}", file=sys.stderr)
        return 1

    blocks: list[str] = [HEADER, ""]
    exported: list[str] = []
    total = 0

    for source in sources:
        payload = json.loads(source.read_text(encoding="utf-8"))
        trace = parse_trace(payload)
        target = source.with_suffix(".fld")
        # newline="\n" so the container is LF on every platform. Python's text mode would
        # otherwise write CRLF on Windows, which the decoder accepts but byte-stability does
        # not want to see vary by checkout host.
        with target.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(encode(trace))
        print(f"wrote {target.relative_to(REPO_ROOT)}  ({len(trace['spans'])} spans)")

        name = source.stem.replace("-", "_")
        blocks.append(f"export const {name.upper()}_TRACE = {typescript_literal(payload)} as const")
        blocks.append("")
        exported.append(name.upper())
        total += 1

    blocks.append("/** Every bundled recording, keyed by the id used in the compare form. */")
    blocks.append("export const SAMPLE_TRACES = {")
    for name in exported:
        blocks.append(f"  {name.lower()}: {name}_TRACE,")
    blocks.append("} as const")
    blocks.append("")
    blocks.append("export type SampleId = keyof typeof SAMPLE_TRACES")
    blocks.append("")
    blocks.append(
        "export const SAMPLE_IDS = Object.keys(SAMPLE_TRACES) as readonly SampleId[]"
    )
    blocks.append("")

    WEB_MODULE.parent.mkdir(parents=True, exist_ok=True)
    with WEB_MODULE.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(blocks))

    _format_like_prettier(WEB_MODULE)

    print(f"wrote {WEB_MODULE.relative_to(REPO_ROOT)}  ({total} recording(s))")
    return 0


def _format_like_prettier(path: Path) -> None:
    """Run prettier over the generated file.

    Without this the drift gate and `format:check` fight each other: the generator writes its
    own layout, prettier rewrites it, and `services/engine/tests/test_generated.py` then reports
    the committed file as stale when it is merely formatted differently. Formatting here means
    the generator's output IS the committed bytes.

    prettier is invoked through `node` on its JS entry point rather than through `npx`, because
    `npx` is a `.cmd` shim on Windows and `subprocess` cannot exec one without a shell.
    """
    node = shutil.which("node")
    cli = REPO_ROOT / "node_modules" / "prettier" / "bin" / "prettier.cjs"
    if node is None or not cli.exists():
        print("  (prettier unavailable; leaving the generated file unformatted)", file=sys.stderr)
        return
    result = subprocess.run(
        [node, str(cli), "--write", str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:  # pragma: no cover - only when prettier is unavailable
        print(f"  (prettier failed: {result.stderr.strip()})", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())