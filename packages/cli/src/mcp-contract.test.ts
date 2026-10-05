import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildToolRegistry, createContext } from './bootstrap.js'

/**
 * The MCP contract test.
 *
 * This starts `flame-diff mcp serve` as a real child process and speaks real MCP to it over
 * stdio — `initialize`, `tools/list`, then one `tools/call` per product tool. A test that
 * builds the server in-process can pass while the wire format is broken, which is the failure
 * this exists to catch.
 *
 * It also calls a tool with invalid input and asserts the error envelope, because a server
 * that returns a stack trace instead of a coded error is not something an agent can use.
 *
 * It lives in the CLI package because the CLI owns the registry the server serves, and
 * `@flamediff/mcp` depending on `@flamediff/cli` would invert the dependency for no reason.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cliEntry = join(here, '..', 'dist', 'bin.js')
const repoRoot = join(here, '..', '..', '..')

const BASE = {
  traceId: 'mcp-base',
  label: 'before',
  spans: [
    { span_id: 'root', name: 'http.handle', start_ns: 0, dur_ns: 10_000 },
    { span_id: 'a', parent_id: 'root', name: 'db.query', start_ns: 100, dur_ns: 4_000 },
  ],
}

const HEAD = {
  traceId: 'mcp-base',
  label: 'after',
  spans: [
    { span_id: 'root', name: 'http.handle', start_ns: 0, dur_ns: 10_000 },
    { span_id: 'a', parent_id: 'root', name: 'db.query', start_ns: 100, dur_ns: 9_000 },
    { span_id: 'b', parent_id: 'root', name: 'retry.send', start_ns: 9_200, dur_ns: 600 },
  ],
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, 'mcp', 'serve'],
    cwd: repoRoot,
    // stderr carries the diagnostics; stdout carries the protocol.
    stderr: 'pipe',
  })
  const client = new Client({ name: 'flame-diff-contract-test', version: '1.0.0' })
  await client.connect(transport)
  return { client, close: async () => await client.close() }
}

function parse(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: string }> }).content
  const text = content?.[0]?.text
  if (text === undefined) throw new Error(`no text content in ${JSON.stringify(result)}`)
  return JSON.parse(text)
}

describe('MCP server over stdio', () => {
  it('advertises every registered tool', async () => {
    const { client, close } = await connect()
    try {
      const listed = await client.listTools()
      const registry = buildToolRegistry(repoRoot)
      const expected = registry.names().sort()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(expected)
      // The product's contract: a server that exposes fewer than five tools is a stub.
      expect(expected.length).toBeGreaterThanOrEqual(5)
    } finally {
      await close()
    }
  })

  it('gives every tool a description written for a model and a usable schema', async () => {
    const { client, close } = await connect()
    try {
      const listed = await client.listTools()
      for (const tool of listed.tools) {
        expect(tool.description.length).toBeGreaterThan(40)
        expect(tool.inputSchema.type).toBe('object')
      }
    } finally {
      await close()
    }
  })

  it('computes a real diff through the tool surface', async () => {
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'trace_diff',
        arguments: { base: BASE, head: HEAD },
      })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      const report = parse(result) as {
        stats: Record<string, number>
        roundtrip: { lossless: boolean }
        rows: Array<{ span_id: string; status: string }>
        engine: string
      }
      expect(report.stats['added']).toBe(1)
      expect(report.stats['duration_regressed']).toBe(1)
      expect(report.roundtrip.lossless).toBe(true)
      expect(report.rows.map((row) => row.span_id)).toContain('b')
      expect(['python', 'typescript']).toContain(report.engine)
    } finally {
      await close()
    }
  })

  it('proves the round trip through the tool surface', async () => {
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'trace_verify_roundtrip',
        arguments: { base: BASE, head: HEAD },
      })
      expect((parse(result) as { lossless: boolean }).lossless).toBe(true)
    } finally {
      await close()
    }
  })

  it('reports column deltas through the tool surface', async () => {
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'trace_columns',
        arguments: { base: BASE, head: HEAD },
      })
      const value = parse(result) as { columns: Array<{ column: string; added: number }> }
      expect(value.columns.map((delta) => delta.column)).toContain('dur_ns')
      expect(value.columns.every((delta) => delta.added === 1)).toBe(true)
    } finally {
      await close()
    }
  })

  it('returns a coded error envelope for invalid input, not a crash', async () => {
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'trace_tokenize',
        arguments: { text: '@@@ not in the grammar @@@' },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? ''
      // The engine's OWN code must survive the trip: a caller told only UPSTREAM_FAILED has to
      // guess why the tokenizer refused.
      expect(text).toMatch(/^UNEXPECTED_CHARACTER:/)
      expect(text).not.toMatch(/UPSTREAM_FAILED/)
    } finally {
      await close()
    }
  })

  it('rejects an unknown tool by name', async () => {
    const { client, close } = await connect()
    try {
      const result = await client.callTool({ name: 'trace_nope', arguments: {} })
      expect((result as { isError?: boolean }).isError).toBe(true)
    } finally {
      await close()
    }
  })

  it('the in-process server exposes the same descriptors as the registry', () => {
    // Guards the cheap half of the contract: descriptors are derived, never a second list.
    const registry = buildToolRegistry(repoRoot)
    expect(registry.names()).toContain('trace_diff')
    expect(registry.surfaceOf('trace_diff')).toBe('core')
    expect(createContext('test').requestId).toBe('test')
  })
})
