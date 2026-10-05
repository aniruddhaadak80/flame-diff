import type { Metadata } from 'next'
import { EmptyState, ErrorState } from '@/components/states'

export const metadata: Metadata = { title: 'Health' }
export const dynamic = 'force-dynamic'

interface Check {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  fix?: string
}

const TONE = { ok: 'ok', warn: 'warn', fail: 'danger' } as const

/**
 * Live diagnostics for this deployment.
 *
 * The most important row is `engine`: it names which implementation answered. On this
 * deployment that is the TypeScript port, because there is no Python runtime — and a reader is
 * entitled to know that before trusting the numbers above it.
 */
export default async function HealthPage() {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'

  let checks: Check[] = []
  let version = 'unknown'
  let ok = false

  try {
    const response = await fetch(`${base}/api/health`, { cache: 'no-store' })
    const body = (await response.json()) as { checks?: Check[]; version?: string; ok?: boolean }
    checks = body.checks ?? []
    version = body.version ?? 'unknown'
    ok = body.ok === true
  } catch (cause) {
    return (
      <div className="stack">
        <section className="hero">
          <span className="eyebrow">Diagnostics</span>
          <h1>Health</h1>
        </section>
        <ErrorState title="The health endpoint could not be reached" code="UNREACHABLE">
          {cause instanceof Error ? cause.message : String(cause)}. The route must be reachable from the
          server runtime that renders this page.
        </ErrorState>
      </div>
    )
  }

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Diagnostics</span>
        <h1>Health</h1>
        <p>
          Live probe results from <code className="inline-code">/api/health</code> on this deployment,
          reporting version {version}.
        </p>
      </section>

      {checks.length === 0 ? (
        <EmptyState title="No checks reported">
          The endpoint responded but returned no probe results, which means the checks array is empty. That is
          a bug in the endpoint, not a healthy deployment.
        </EmptyState>
      ) : (
        <div className="grid">
          {checks.map((check) => (
            <article className="card" key={check.name}>
              <span className="badge" data-tone={TONE[check.status]}>
                {check.status}
              </span>
              <h2>{check.name}</h2>
              <p>{check.detail}</p>
              {check.fix !== undefined ? (
                <p className="field__hint">
                  <strong>fix:</strong> {check.fix}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <p className="field__hint">
        Overall status: <strong>{ok ? 'passing' : 'failing'}</strong>.
      </p>
    </div>
  )
}
