# CLI reference

```bash
flame-diff <command> [options]
```

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | success                                                    |
| `1`  | runtime failure (a check failed, a tool returned an error) |
| `2`  | usage error (unknown command or flag)                      |

## Commands

| Command                 | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `flame-diff doctor`     | probe every subsystem, print status + fix hint per row  |
| `flame-diff version`    | version and runtime information as JSON                 |
| `flame-diff tools`      | list registered tools                                   |
| `flame-diff skills`     | list the skill catalog with validation issues           |
| `flame-diff plugins`    | show the resolved plugin registry, including rejections |
| `flame-diff run <tool>` | invoke one tool with a JSON input document              |

## Machine-readable output

Every read-only command accepts `--json`, which writes a single JSON document to stdout and
nothing else. Diagnostics always go to stderr, so `--json` output is always safe to pipe into
a parser.

```bash
flame-diff tools --json | jq '.[] | select(.surface == "core")'
```

## The `doctor` contract

`doctor` never throws. A failing subsystem becomes a row with a status, a detail, and a
**fix** hint. The exit code is `1` if any required check failed, `0` otherwise. This is what
lets it run in CI as a smoke test without taking the build down on a missing optional
credential.
