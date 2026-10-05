import { NextResponse } from 'next/server'
import { analyse } from '@flamediff/tracekit'
import { PRODUCT, resolveVersion } from '@/lib/product'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Status = 'ok' | 'warn' | 'fail'
interface Check {
  name: string
  status: Status
  detail: string
  fix?: string
}

const startedAt = Date.now()

/**
 * A health endpoint that reports only things it can actually observe at runtime.
 *
 * The engine row is the important one: it names WHICH implementation answered. On Vercel that
 * is the TypeScript port, because there is no Python runtime — and a reader is entitled to
 * know that the report they are looking at was produced by the port rather than the
 * reference, even though both are held to the same golden output.
 */
function probe(): { ok: boolean; checks: Check[] } {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0')
  checks.push(
    nodeMajor >= 22
      ? { name: 'runtime', status: 'ok', detail: `node ${process.versions.node}` }
      : {
          name: 'runtime',
          status: 'fail',
          detail: `node ${process.versions.node} is below the required v22.12.0`,
          fix: 'target Node 22 in the deployment runtime',
        },
  )

  checks.push({ name: 'package', status: 'ok', detail: `${PRODUCT.slug}@${resolveVersion()}` })

  // Actually exercise the engine rather than asserting it is importable: a probe that only
  // checks a module resolves proves nothing about whether it computes.
  try {
    const canonical = analyse('canonicalize', {
      trace: {
        trace_id: 'health',
        label: 'probe',
        spans: [{ span_id: 'p', name: 'probe', start_ns: 0, dur_ns: 1 }],
      },
    }) as { lossless?: boolean; span_count?: number }
    checks.push(
      canonical.lossless === true && canonical.span_count === 1
        ? {
            name: 'engine',
            status: 'ok',
            detail: `tracekit (TypeScript port of the Python reference) round-tripped a probe span`,
          }
        : {
            name: 'engine',
            status: 'fail',
            detail: 'the engine answered but did not report a lossless round trip',
            fix: 'check packages/tracekit against fixtures/golden/cases.json',
          },
    )
  } catch (cause) {
    checks.push({
      name: 'engine',
      status: 'fail',
      detail: `the engine threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      fix: 'check packages/tracekit is built and its dependencies are installed',
    })
  }

  const region = process.env.VERCEL_REGION ?? 'local'
  checks.push({ name: 'region', status: 'ok', detail: region })

  const python = process.env.PRODUCT_PYTHON
  checks.push({
    name: 'python reference',
    status: python === undefined ? 'warn' : 'ok',
    detail:
      python === undefined
        ? 'no python on this runtime — answers come from the TypeScript port'
        : `configured as ${python}`,
    ...(python === undefined
      ? { fix: 'set PRODUCT_PYTHON where a Python runtime is available to use the reference' }
      : {}),
  })

  const ok = checks.every((check) => check.status !== 'fail')
  return { ok, checks }
}

export function GET() {
  const { ok, checks } = probe()
  return NextResponse.json(
    {
      ok,
      name: PRODUCT.slug,
      version: resolveVersion(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
      runtime: process.versions.node,
      region: process.env.VERCEL_REGION ?? 'local',
      engine: 'tracekit',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
