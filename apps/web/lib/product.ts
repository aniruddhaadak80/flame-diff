import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The product's identity and its surface manifest, in one typed place.
 *
 * Both the web UI and the health endpoint read from here, so a value is never stated twice.
 * The manifest also records the surfaces this repository deliberately does NOT ship, with the
 * reason. An omission that is not written down reads as an oversight, and a reviewer cannot
 * tell the difference between a considered decision and a gap.
 */
export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped' | 'omitted'
  /** Required when `status` is 'omitted': why the surface is not here. */
  readonly reason?: string
}

export const PRODUCT = {
  name: 'Flame Diff',
  slug: 'flame-diff',
  version: '0.1.0',
  tagline:
    'Compare two execution recordings token by token, and prove the comparison faithful by reconstructing the original from its own token stream.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'cli',
    title: 'CLI',
    summary:
      'diff, canonicalize, tokenize, columns, verify, doctor, tools, mcp serve, mcp call. The no-browser path, and the one that pastes output into a pull request.',
    status: 'shipped',
  },
  {
    id: 'api',
    title: 'JSON API',
    summary:
      'POST /api/diff and GET /api/health. The flagship surface: the same computation the CLI and MCP server perform, reachable without installing anything.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'Web app',
    summary:
      'A form and a single-column timeline. Server-rendered on first paint with real product data, plus a paste-your-own path that posts to the same API.',
    status: 'shipped',
  },
  {
    id: 'mcp',
    title: 'MCP server and client',
    summary:
      'Speaks real MCP over stdio, exposing the whole tool registry. Proven by a contract test that starts the binary and speaks the protocol to it.',
    status: 'shipped',
  },
  {
    id: 'engine',
    title: 'Python reference engine',
    summary:
      'Tokenizer, Myers edit script, classifier, and the FLDC columnar codec. Pure functions, mypy-strict, 141 tests including property and golden tests.',
    status: 'shipped',
  },
  {
    id: 'tracekit',
    title: 'TypeScript port',
    summary:
      'The same engine for hosts with no Python runtime. Held to the reference by one golden file that both suites assert.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary: 'Markdown skills loaded from disk, with frontmatter validation and a version-bump gate.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary:
      'Manifest-driven classification rules and column codecs, with priority-based conflict resolution.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Memory',
    summary:
      'SQLite with WAL and numbered migrations, indexing recordings and reports over the columnar payloads.',
    status: 'shipped',
  },
  {
    id: 'desktop',
    title: 'Desktop (Electron)',
    summary: 'A shell that loads the web build in a native window.',
    status: 'omitted',
    reason:
      'This product is api-first. An Electron shell is a strictly worse copy of a URL, and it would add a ~250MB dependency tree to every install for no capability the web app lacks.',
  },
  {
    id: 'channels',
    title: 'Channels',
    summary: 'Adapters for reaching a remote surface — chat platforms, webhooks, queues.',
    status: 'omitted',
    reason:
      'flame-diff is local-first: it reads recordings you hand it. There is no remote surface to talk to, so a channel adapter would have nothing to send.',
  },
  {
    id: 'providers',
    title: 'Model providers',
    summary: 'LLM provider adapters behind one interface.',
    status: 'omitted',
    reason:
      'The entire value of this product is that the answer is computed rather than generated. Shipping a model provider in a repository whose claim is determinism would contradict the claim.',
  },
]

function packageVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function resolveVersion(): string {
  return packageVersion()
}
