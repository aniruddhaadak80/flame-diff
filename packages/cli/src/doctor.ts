import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from '@flamediff/skills'
import { buildRegistry as buildPluginRegistry } from '@flamediff/plugins'

export type Status = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly Check[]
}

const pkg = { name: 'flame-diff', version: '0.1.0' }

/**
 * The flagship command. An agent that mutates its own configuration must be able to
 * diagnose itself, and every failing row carries a fix hint rather than only a status.
 */
export async function doctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(
    nodeMajor >= 22
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is below the required v22.12.0`,
          fix: 'install Node 22.12 or newer (see .nvmrc)',
        },
  )

  checks.push({
    name: 'package',
    status: 'ok',
    detail: `${pkg.name}@${pkg.version}`,
  })

  // The engine is the product. If the Python reference cannot be reached, say so plainly and
  // say what is being used instead — a report that came from the port is still correct, but
  // the operator is entitled to know which engine produced it.
  const { EngineRunner } = await import('@flamediff/engine-client')
  const probe = await new EngineRunner({ root: cwd }).probe()
  checks.push(
    probe.reachable
      ? {
          name: 'engine',
          status: 'ok',
          detail: `python reference engine responded${probe.version === undefined ? '' : ` (v${probe.version})`}`,
        }
      : {
          name: 'engine',
          status: 'warn',
          detail: `python reference unreachable — the TypeScript port answers instead (${probe.detail})`,
          fix: 'install Python 3.11+ and run "pip install -e services/engine[dev]", or set PRODUCT_PYTHON',
        },
  )

  const skills = loadCatalog(join(cwd, 'skills'))
  checks.push(
    skills.issues.length === 0
      ? { name: 'skills', status: 'ok', detail: `${skills.skills.length} skills, 0 invalid` }
      : {
          name: 'skills',
          status: 'fail',
          detail: `${skills.skills.length} valid, ${skills.issues.length} invalid`,
          fix: skills.issues[0] ?? 'see npm run check:skill-version',
        },
  )

  const plugins = buildPluginRegistry(join(cwd, 'plugins'))
  checks.push(
    plugins.rejected.length === 0
      ? {
          name: 'plugins',
          status: 'ok',
          detail: `${plugins.active.length} active, ${plugins.disabled.length} disabled`,
        }
      : {
          name: 'plugins',
          status: 'warn',
          detail: `${plugins.rejected.length} rejected`,
          fix: plugins.rejected[0]?.issues[0] ?? 'inspect plugins/*/plugin.json',
        },
  )

  const configPath = join(cwd, 'product.config.json')
  checks.push(
    existsSync(configPath)
      ? { name: 'config', status: 'ok', detail: 'product.config.json found' }
      : {
          name: 'config',
          status: 'warn',
          detail: 'no product.config.json — using defaults',
          fix: 'run with defaults, or create product.config.json',
        },
  )

  return { ok: checks.every((check) => check.status !== 'fail'), checks }
}

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.name.length), 5)
  const icon = (status: Status): string => (status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL')
  const lines = report.checks.map((check) => {
    const head = `  [${icon(check.status)}] ${check.name.padEnd(width)}  ${check.detail}`
    return check.fix === undefined ? head : `${head}\n         fix: ${check.fix}`
  })
  return [
    `${pkg.name} doctor`,
    ...lines,
    '',
    report.ok ? 'all required checks passed' : 'one or more checks failed',
  ].join('\n')
}
