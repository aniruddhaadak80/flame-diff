/**
 * Proof that the MCP surface speaks real MCP over stdio.
 *
 * This is not a test — it is a demonstration, and it is run from the command line so its
 * output can be pasted into the README and the final report. It starts
 * `flame-diff mcp serve` as a child process and performs a real handshake:
 * `initialize`, `tools/list`, then a `tools/call` that reaches the Python engine.
 *
 *   node scripts/mcp-proof.mjs
 *
 * A test that constructs the server in-process can pass while the wire format is broken. This
 * cannot: if the handshake fails, there is no output.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = join(root, 'packages', 'cli', 'dist', 'bin.js')

const BASE = {
  trace_id: 'mcp-proof',
  label: 'before',
  spans: [
    { span_id: 'root', name: 'http.handle', start_ns: 0, dur_ns: 10000 },
    { span_id: 'a', parent_id: 'root', name: 'db.query', start_ns: 100, dur_ns: 4000 },
  ],
}

const HEAD = {
  trace_id: 'mcp-proof',
  label: 'after',
  spans: [
    { span_id: 'root', name: 'http.handle', start_ns: 0, dur_ns: 10000 },
    { span_id: 'a', parent_id: 'root', name: 'db.query', start_ns: 100, dur_ns: 9000 },
    { span_id: 'b', parent_id: 'root', name: 'retry.send', start_ns: 9100, dur_ns: 600 },
  ],
}

function parse(result) {
  const text = result?.content?.[0]?.text
  if (text === undefined) throw new Error('no text content in the tool result')
  return JSON.parse(text)
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliEntry, 'mcp', 'serve'],
  cwd: root,
  stderr: 'pipe',
})

const client = new Client({ name: 'flame-diff-mcp-proof', version: '1.0.0' })

// 1. initialize — a real MCP handshake over stdio with the built binary as the server.
await client.connect(transport)
const version = client.getServerVersion() ?? {}
console.log(`initialize            -> server ${version.name} v${version.version}`)

// 2. tools/list — every tool the registry exposes, advertised over the wire.
const listed = await client.listTools()
console.log(`tools/list            -> ${listed.tools.length} tools`)
for (const tool of listed.tools) console.log(`                         - ${tool.name}`)

// 3. tools/call that reaches the Python engine.
const diff = parse(await client.callTool({ name: 'trace_diff', arguments: { base: BASE, head: HEAD } }))
console.log(`tools/call trace_diff -> edit_cost=${diff.edit_cost} lossless=${diff.roundtrip.lossless}`)
console.log(`                         engine=${diff.engine}`)
console.log(
  `                         stats: added=${diff.stats.added} regressed=${diff.stats.duration_regressed}`,
)
for (const row of diff.rows) {
  console.log(`                         ${row.status.padEnd(20)} ${row.name}`)
}

// 4. A refusal must arrive as a coded error envelope, not a crash.
const refused = await client.callTool({
  name: 'trace_tokenize',
  arguments: { text: '@@ not in the grammar @@' },
})
console.log(`tools/call (invalid)  -> isError=${refused.isError} ${refused.content[0].text}`)

// 5. The faithfulness proof, over the wire.
const verified = parse(
  await client.callTool({ name: 'trace_verify_roundtrip', arguments: { base: BASE, head: HEAD } }),
)
console.log(`tools/call verify     -> lossless=${verified.lossless}`)

await client.close()
console.log('closed cleanly')
