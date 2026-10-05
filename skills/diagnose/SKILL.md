---
name: diagnose
description: Use when Flame Diff is misbehaving and the cause is not obvious, because the diagnostic order below finds the failing subsystem without guesswork.
metadata:
  version: 1.1.0
---

# Diagnose Flame Diff

## When to use this

Something is broken and you do not yet know which subsystem is at fault.

## Steps

1. `flame-diff doctor` — read the failing row **and its fix line**. Do not skip to step 2; every
   row carries the specific remedy.

2. If `engine` warns, that is the important one. It means the Python reference could not be
   reached and the **TypeScript port** answered instead. The report is still correct — both are
   held to the same golden output — but the fix is to make Python available:

   ```bash
   pip install -e services/engine
   ```

   `PRODUCT_PYTHON` overrides which interpreter is used. `flame-diff doctor --json` prints the
   machine-readable form.

3. If `skills` fails, the catalog will not load: `flame-diff tools` lists `list_skills`, whose
   output includes an `issues` array naming each file. Fix the frontmatter; do not delete the
   skill.

4. If a single capability misbehaves, confirm it is registered and call it directly:

   ```bash
   flame-diff tools
   flame-diff mcp call trace_tokenize '{"text":"@"}'
   ```

   The second prints a stable error code. `UNEXPECTED_CHARACTER` means the text is outside the
   canonical grammar, which is a refusal and not a crash.

5. If the deployed web app disagrees with the CLI, check which engine answered:

   ```bash
   curl -s <deployment-url>/api/health
   ```

   The `engine` row names the implementation and `checks` lists what it actually probed. On
   Vercel it will be `tracekit`, because there is no Python runtime.

## Error codes

| Code                   | Meaning                                    | First move                             |
| ---------------------- | ------------------------------------------ | -------------------------------------- |
| `BAD_SHAPE`            | the recording failed validation            | the message names the offending field  |
| `DUPLICATE_SPAN_ID`    | two spans share an id                      | fix the exporter; ids must be stable   |
| `NEGATIVE_VALUE`       | a negative start or duration               | fix the exporter                       |
| `UNTERMINATED_STRING`  | a span name contains an unterminated quote | fix the exporter                       |
| `UNEXPECTED_CHARACTER` | text outside the canonical grammar         | canonicalise first, then tokenise      |
| `BAD_MAGIC`            | the file is not an `FLDC` container        | check the extension and the first line |
| `DEPTH_MISMATCH`       | stored depth contradicts the stored tree   | the container is corrupt; re-export    |

## Verify

`flame-diff doctor` exits 0.
