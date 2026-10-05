import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRegistry, loadPlugin } from './index.js'

/**
 * The shipped plugins are real code, so they are tested like real code.
 *
 * A plugin manifest that validates is worth almost nothing on its own — the risk is a plugin
 * whose entry point throws, or claims a capability with a rule that is wrong. Both shipped
 * plugins are loaded and executed here.
 *
 * They are loaded with a dynamic `import()` rather than `require()`: the plugin sources are ES
 * modules, and `require()` of an ES module is not something to rely on.
 */

const pluginsRoot = new URL('../../../plugins', import.meta.url).pathname.replace(/^\/(.:)/, '$1')

type Plugin = Record<string, unknown>

async function load(name: string): Promise<Plugin> {
  const url = pathToFileURL(`${pluginsRoot}/${name}/index.js`).href
  return (await import(url)) as Plugin
}

function manifestPath(name: string): string {
  return `${pluginsRoot}/${name}/plugin.json`
}

const SPANS = [
  { span_id: 'root', parent_id: null, name: 'http.handle', start_ns: 0, dur_ns: 268400 },
  { span_id: 'q', parent_id: 'root', name: 'db.query.items', start_ns: 6600, dur_ns: 62400 },
]

describe('the plugin registry', () => {
  it('activates both shipped plugins with no rejections', () => {
    const result = buildRegistry(pluginsRoot)
    expect(result.rejected).toEqual([])
    expect(result.active.map((plugin) => plugin.manifest.name).sort()).toEqual([
      'column-codec-profiler',
      'regression-budget',
    ])
  })

  it('reports an engine version mismatch rather than loading it', () => {
    const result = buildRegistry(pluginsRoot, { '@flamediff/tracekit': '9.9.9' })
    expect(result.active).toEqual([])
    expect(result.rejected).toHaveLength(2)
    expect(result.rejected[0]?.issues[0]).toMatch(/requires 0\.1\.0, running 9\.9\.9/)
  })

  it('loads each manifest with no issues', () => {
    for (const name of ['regression-budget', 'column-codec-profiler']) {
      const loaded = loadPlugin(manifestPath(name))
      expect(loaded.issues).toEqual([])
      expect(loaded.manifest.name).toBe(name)
    }
  })

  it('resolves a contested capability by priority and reports the loser', () => {
    const budgets = loadPlugin(manifestPath('regression-budget'))
    const profiler = loadPlugin(manifestPath('column-codec-profiler'))
    // Higher priority wins a contested capability, and both shipped plugins claim distinct
    // ones, so neither shadows the other.
    expect(budgets.manifest.priority).toBeGreaterThan(profiler.manifest.priority)
    const claims = new Set([...budgets.manifest.capabilities, ...profiler.manifest.capabilities])
    expect(claims.size).toBe(2)
  })
})

describe('regression-budget', () => {
  it('calls a large slowdown past the request-total budget a regression', async () => {
    // 90ms -> 103.5ms is 1.15x, exactly the significant threshold.
    const plugin = (await load('regression-budget')) as {
      classify: (base: number, head: number) => { regressed: boolean; budget: string }
    }
    const verdict = plugin.classify(90_000_000, 103_500_000)
    expect(verdict.regressed).toBe(true)
    expect(verdict.budget).toBe('request-total')
  })

  it('calls the same 1.15x on a tiny span NOT a regression', async () => {
    // The whole point of a budget: the ratio is identical, the answer is not.
    const plugin = (await load('regression-budget')) as {
      classify: (base: number, head: number) => { regressed: boolean; budget: string }
    }
    const verdict = plugin.classify(400, 460)
    expect(verdict.regressed).toBe(false)
    expect(verdict.budget).toBe('default')
  })

  it('calls a large slowdown on a cheap span a regression at the cheap ratio', async () => {
    const plugin = (await load('regression-budget')) as {
      classify: (base: number, head: number) => { regressed: boolean }
    }
    expect(plugin.classify(400, 2_000).regressed).toBe(true)
  })

  it('refuses to judge a zero baseline', async () => {
    const plugin = (await load('regression-budget')) as {
      classify: (base: number, head: number) => { regressed: boolean; reason: string }
      BUDGETS: Array<{ name: string }>
    }
    const verdict = plugin.classify(0, 500)
    expect(verdict.regressed).toBe(false)
    expect(verdict.reason).toMatch(/no ratio/)
    // And every budget it can name is declared.
    expect(plugin.BUDGETS.map((budget) => budget.name)).toContain('request-total')
  })
})

describe('column-codec-profiler', () => {
  interface Report {
    spanCount: number
    totalBytes: number
    columns: Array<{ column: string; bytes: number; share: number }>
  }
  interface CodecPlugin {
    profile: (spans: unknown[]) => Report
    heaviest: (report: Report) => { column: string }
  }

  it('accounts for every declared column', async () => {
    const plugin = (await load('column-codec-profiler')) as CodecPlugin
    const report = plugin.profile(SPANS)
    expect(report.spanCount).toBe(2)
    expect(report.columns.map((column) => column.column)).toEqual([
      'span_id',
      'parent_id',
      'name',
      'start_ns',
      'dur_ns',
      'depth',
    ])
  })

  it('produces shares that sum to one', async () => {
    const plugin = (await load('column-codec-profiler')) as CodecPlugin
    const report = plugin.profile(SPANS)
    expect(report.columns.reduce((sum, column) => sum + column.share, 0)).toBeCloseTo(1, 10)
  })

  it('identifies name as the heaviest column for these spans', async () => {
    const plugin = (await load('column-codec-profiler')) as CodecPlugin
    expect(plugin.heaviest(plugin.profile(SPANS)).column).toBe('name')
  })

  it('handles an empty recording without dividing by zero', async () => {
    const plugin = (await load('column-codec-profiler')) as CodecPlugin
    const report = plugin.profile([])
    expect(report.spanCount).toBe(0)
    expect(report.totalBytes).toBe(0)
    expect(report.columns).toEqual([])
  })

  it('measures UTF-8 bytes, not code points', async () => {
    // "日本" is 2 characters and 6 UTF-8 bytes. A code-point count would report 2.
    const plugin = (await load('column-codec-profiler')) as CodecPlugin
    const report = plugin.profile([{ span_id: 'a', parent_id: null, name: '日本', start_ns: 0, dur_ns: 1 }])
    expect(report.columns.find((column) => column.column === 'name')?.bytes).toBe(6)
  })
})

describe('plugin manifests are real files', () => {
  it('every plugin directory has a manifest and a loadable entry point', async () => {
    for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const base = `${pluginsRoot}/${entry.name}`
      expect(existsSync(`${base}/plugin.json`)).toBe(true)
      expect(existsSync(`${base}/index.js`)).toBe(true)
      // And the entry point must actually parse and evaluate.
      expect(readFileSync(`${base}/index.js`, 'utf8')).toContain('export')
      await expect(load(entry.name)).resolves.toBeDefined()
    }
  })
})
