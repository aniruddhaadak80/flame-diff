import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { errorCodeOf } from '@flamediff/core'
import type { Report, Trace } from '@flamediff/tracekit'
import { buildToolRegistry, createContext } from './bootstrap.js'
import { doctor, renderReport } from './doctor.js'
import { readTraceFile, renderColumnDeltas, renderHunks, renderSummary, renderTimeline } from './render.js'

const VERSION = '0.1.0'

/** Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error. */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('flame-diff')
    .description(
      'Compare two execution recordings token by token, and prove the comparison faithful by reconstructing the original from its own token stream.',
    )
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride((error) => {
      process.exitCode = error.exitCode === 0 ? 0 : 2
      throw error
    })

  const json = (command: Command): Command => command.option('--json', 'machine-readable output')

  program
    .command('doctor')
    .description('diagnose every subsystem and print an actionable report')
    .option('--json', 'machine-readable output')
    .action(async () => {
      const report = await doctor()
      process.stdout.write(
        process.argv.includes('--json')
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${renderReport(report)}\n`,
      )
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('tools')
    .description('list the registered tools — the authoritative capability list')
    .option('--json', 'machine-readable output')
    .action(() => {
      const registry = buildToolRegistry()
      const tools = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        surface: registry.surfaceOf(tool.name),
        source: registry.sourceOf(tool.name),
        permissions: tool.permissions,
        inputSchema: tool.inputSchema,
      }))
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
        return
      }
      const width = Math.max(...tools.map((tool) => tool.name.length), 4)
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(width)}  [${tool.surface}]  ${tool.description}\n`)
      }
    })

  // ---------------------------------------------------------------- the product commands

  program
    .command('diff')
    .description('compare two recordings and print the change as a single-column timeline')
    .argument('<base>', 'the recording before the change (.fld or .json)')
    .argument('<head>', 'the recording after the change (.fld or .json)')
    .option('--regression-ratio <ratio>', 'a duration counts as a regression past this multiple', '1.25')
    .option('--min-duration-ns <ns>', 'ignore duration changes below this many nanoseconds', '0')
    .option('--changed-only', 'hide unchanged spans')
    .option('--columns', 'also print the per-column deltas')
    .option('--hunks', 'also print the minimal token edit script')
    .option('--json', 'machine-readable output')
    .action(async (basePath: string, headPath: string, flags: Record<string, string | boolean>) => {
      const report = await runDiff(basePath, headPath, flags)
      if (flags['json'] === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        return
      }
      const blocks = [renderSummary(report)]
      if (flags['columns'] === true) {
        blocks.push('columns\n' + renderColumnDeltas(report.column_deltas))
      }
      if (flags['hunks'] === true) {
        blocks.push('minimal edit script\n' + renderHunks(report))
      }
      blocks.push('timeline\n' + renderTimeline(report, flags['changedOnly'] === true))
      process.stdout.write(`${blocks.join('\n\n')}\n`)
      if (!report.roundtrip.lossless) process.exitCode = 1
    })

  json(
    program
      .command('canonicalize')
      .description('render one recording in canonical form')
      .argument('<path>', 'a recording (.fld or .json)'),
  ).action(async (path: string, flags: Record<string, string | boolean>) => {
    const trace = await loadTrace(path)
    const value = (await invoke('trace_canonicalize', trace)) as Record<string, unknown>
    if (flags['json'] === true) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
      return
    }
    process.stdout.write(`${String(value['text'])}\n`)
  })

  json(
    program
      .command('tokenize')
      .description('split a canonical rendering into typed tokens and prove the round trip')
      .argument('<path>', 'a recording (.fld or .json), or a .txt canonical rendering'),
  ).action(async (path: string, flags: Record<string, string | boolean>) => {
    const text = readFileSync(path, 'utf8')
    const input = text.startsWith('(') ? { text } : await canonicalTextFor(path)
    const value = (await invoke('trace_tokenize', input)) as Record<string, unknown>
    if (flags['json'] === true) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
      return
    }
    const tokens = value['tokens'] as Array<{ kind: string; text: string; start: number; end: number }>
    process.stdout.write(
      `${tokens
        .map(
          (token) =>
            `${String(token.start).padStart(5)}..${String(token.end).padEnd(5)} ${token.kind.padEnd(7)} ${token.text}`,
        )
        .join('\n')}\n\n` +
        `${value['token_count']} token(s), ${value['significant_count']} significant, ` +
        `round trip ${value['lossless'] === true ? 'verified lossless' : 'FAILED'}\n`,
    )
  })

  json(
    program
      .command('columns')
      .description('report how each column of the columnar store moved between two recordings')
      .argument('<base>', 'the recording before the change')
      .argument('<head>', 'the recording after the change'),
  ).action(async (basePath: string, headPath: string, flags: Record<string, string | boolean>) => {
    const value = (await invoke('trace_columns', {
      base: await loadTrace(basePath),
      head: await loadTrace(headPath),
    })) as { columns: Report['column_deltas'] }
    if (flags['json'] === true) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
      return
    }
    process.stdout.write(`  ${renderColumnDeltas(value.columns)}\n`)
  })

  json(
    program
      .command('verify')
      .description('prove a comparison is faithful by rebuilding each recording from its tokens')
      .argument('<base>', 'the recording before the change')
      .argument('<head>', 'the recording after the change'),
  ).action(async (basePath: string, headPath: string, flags: Record<string, string | boolean>) => {
    const value = (await invoke('trace_verify_roundtrip', {
      base: await loadTrace(basePath),
      head: await loadTrace(headPath),
    })) as { base: { lossless: boolean }; head: { lossless: boolean }; lossless: boolean }
    if (flags['json'] === true) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    } else {
      process.stdout.write(
        `base: ${value.base.lossless ? 'lossless' : 'FAILED'}   ` +
          `head: ${value.head.lossless ? 'lossless' : 'FAILED'}\n` +
          `verdict: ${value.lossless ? 'both recordings survived their own token stream' : 'ROUND TRIP FAILED'}\n`,
      )
    }
    if (!value.lossless) process.exitCode = 1
  })

  // ---------------------------------------------------------------- protocol

  const mcp = program.command('mcp').description('Model Context Protocol commands')

  mcp
    .command('serve')
    .description('run the MCP server over stdio')
    .action(async () => {
      const { serveStdio } = await import('@flamediff/mcp')
      const registry = buildToolRegistry()
      // stdout belongs to the protocol from here on; diagnostics must go to stderr.
      await serveStdio(registry, createContext('mcp'))
    })

  mcp
    .command('call')
    .description('invoke one tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .argument('<input>', 'JSON input document')
    .action(async (tool: string, raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        process.stderr.write(`error: input is not valid JSON — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      try {
        const value = await invoke(tool, parsed)
        process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`)
      } catch (cause) {
        const code = errorCodeOf(cause)
        process.stderr.write(`${code}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('version')
    .description('print version and runtime information as JSON')
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            name: 'flame-diff',
            version: VERSION,
            node: process.versions.node,
            platform: process.platform,
            tools: buildToolRegistry().size,
          },
          null,
          2,
        )}\n`,
      )
    })

  return program
}

// ---------------------------------------------------------------------- helpers

async function invoke(tool: string, input: unknown): Promise<unknown> {
  const registry = buildToolRegistry()
  return await registry.invoke(tool, input, createContext('cli'), ['fs:read', 'net:fetch', 'proc:spawn'])
}

/** Load a recording: decode an FLDC container, or accept a JSON trace document as-is. */
async function loadTrace(path: string): Promise<Record<string, unknown>> {
  const loaded = readTraceFile(path)
  if (typeof loaded === 'object' && loaded !== null && 'container' in loaded) {
    const decoded = (await invoke('trace_container', {
      mode: 'decode',
      text: (loaded as { container: string }).container,
    })) as { trace: Trace }
    return { traceId: decoded.trace.trace_id, label: decoded.trace.label, spans: decoded.trace.spans }
  }
  const raw = loaded as Record<string, unknown>
  // Accept either a bare trace document or one already in the tool's input shape.
  if (Array.isArray(raw['spans']) && 'trace_id' in raw) {
    return { traceId: raw['trace_id'], label: raw['label'] ?? '', spans: raw['spans'] }
  }
  return raw
}

async function canonicalTextFor(path: string): Promise<{ text: string }> {
  const value = (await invoke('trace_canonicalize', await loadTrace(path))) as { text: string }
  return { text: value.text }
}

async function runDiff(
  basePath: string,
  headPath: string,
  flags: Record<string, string | boolean>,
): Promise<Report> {
  // Commander camelCases dashed flags into the options object: --regression-ratio arrives as
  // `regressionRatio`. Reading the dashed spelling here would silently fall back to the
  // default every time, which is the kind of bug a CLI smoke test exists to catch.
  const raw = (await invoke('trace_diff', {
    base: await loadTrace(basePath),
    head: await loadTrace(headPath),
    regressionRatio: Number(flags['regressionRatio'] ?? 1.25),
    minDurationNs: Number(flags['minDurationNs'] ?? 0),
  })) as Report
  return raw
}
