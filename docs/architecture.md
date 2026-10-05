# Architecture

## The narrow waist

Every capability is a `Tool`. One registry. One interface. Four transports.

```
                    ┌──────────────┐
   CLI ────────────▶│              │
   Web ────────────▶│  ToolRegistry│────▶ packages/memory  (SQLite, WAL, FTS)
   MCP server ─────▶│              │
   Channel ─────────▶└──────────────┘
```

The CLI, the web app, the MCP server, and every channel adapter are transports. None of them
contains product logic. If one of them needs a behaviour, that behaviour belongs in a tool.

## Invariants

1. **Tools are stateless.** State lives in `packages/memory`, addressed through the context.
2. **Input is validated before the handler runs.** Never after, never partially.
3. **Permissions are declared, not assumed.** `doctor` cross-checks declarations against the
   registry; a tool that touches more than it declares is a bug.
4. **Duplicate tool names throw**, naming both registrants. A silent overwrite is an
   undebuggable product bug.
5. **No cross-package deep imports.** Only declared entry points. Enforced by
   `check:boundaries`.

## The footprint ladder

Where new capability goes, in order of preference:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool
4. Add a plugin
5. Add an MCP server tool
6. Add a new core tool — last resort

Every core tool is paid for in context window on every request, forever. Plugins are free.
That asymmetry is the whole reason for the ladder.

## The deterministic engine

The parts that must be exactly right are code, not generation. They live in
`services/engine`: a dependency-free Python package called as a **pure function** over
stdin/stdout. No server, no port, no daemon, no shared state — so two concurrent calls can
never interfere, and every operation is property-testable in isolation.

See [adr/0002-python-engine-boundary.md](adr/0002-python-engine-boundary.md).

## Packages

| Package         | Responsibility                                                               |
| --------------- | ---------------------------------------------------------------------------- |
| `core`          | the `Tool` interface, the registry, permissions, the error taxonomy. No I/O. |
| `config`        | layered config; the zod schema is the source of truth                        |
| `memory`        | SQLite index over the columnar payloads, numbered migrations, FTS5           |
| `skills`        | `SKILL.md` discovery, frontmatter parsing, catalog validation                |
| `plugins`       | manifest loading, schema validation, priority conflict resolution            |
| `mcp`           | MCP server (stdio) and MCP client, both over the core registry               |
| `engine-client` | subprocess bridge to the reference engine, with the port as fallback         |
| `tracekit`      | the TypeScript port of the engine, held to the reference by a golden file    |
| `cli`           | commander CLI; `doctor` is the flagship command                              |
| `sdk`           | the public facade — the stable surface and nothing else                      |

## Two engines, one golden file

`services/engine` (Python) is the **reference implementation** and owns the behaviour.
`packages/tracekit` is a TypeScript **port**, and it exists because Vercel runs the web app in a
Node function with no Python runtime.

The port is not trusted on its own account. `fixtures/golden/cases.json` is generated from the
Python implementation, and **both** test suites assert it:

```
services/engine/tests/test_golden.py     reference vs. golden
packages/tracekit/src/golden.test.ts     port     vs. golden
```

If the two disagree about one byte, one of those suites goes red. This is not theoretical — the
gate caught a floor-versus-truncate disagreement on negative percentages and an ordering
inconsistency for cyclic recordings, both of which had compiled and produced plausible output.

See [adr/0003-typescript-port-for-web.md](adr/0003-typescript-port-for-web.md).

## Deliberate omissions

**No `channels` package.** flame-diff is local-first: it reads recordings you hand it. There is no
remote surface to talk to, so a channel adapter would have nothing to send.

**No `providers` package.** The product's central claim is that the answer is computed rather
than generated. Shipping a model provider in this repository would contradict the claim, so
nothing in the comparison path can call a model.

**No `apps/desktop`.** The product is api-first. An Electron shell is a strictly worse copy of a
URL and would add a ~250MB dependency tree to every install for no capability the web app lacks.
