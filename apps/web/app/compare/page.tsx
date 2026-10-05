import Link from 'next/link'
import { compare, loadSample, sampleOptions } from '@/lib/data'
import { ReportView } from '@/components/ReportView'
import { EmptyState, ErrorState } from '@/components/states'

/**
 * The server-rendered comparison. No JavaScript required.
 *
 * The form on the home page is a plain GET, so this page is a complete, linkable,
 * shareable, server-rendered view of any pair of bundled recordings. That matters for a tool
 * whose output goes into a pull request: the link has to keep working for whoever opens it
 * next year, in a terminal browser, on a machine with no toolchain.
 *
 * All three states are handled distinctly: an unknown sample id, a recording with no spans,
 * and a refused comparison are three different problems with three different fixes.
 */
export const dynamic = 'force-dynamic'

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ base?: string; head?: string }>
}) {
  const query = await searchParams
  const baseId = query.base ?? 'before'
  const headId = query.head ?? 'after'

  const base = loadSample(baseId)
  const head = loadSample(headId)
  const options = sampleOptions()

  const form = (
    <form className="compare-form" action="/compare" method="get">
      <div className="compare-form__row">
        <div className="field">
          <label htmlFor="base">Before</label>
          <select id="base" name="base" defaultValue={base === null ? '' : baseId}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="head">After</label>
          <select id="head" name="head" defaultValue={head === null ? '' : headId}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button className="button" type="submit">
        Compare
      </button>
    </form>
  )

  if (base === null || head === null) {
    const missing = base === null ? baseId : headId
    return (
      <div className="stack">
        <section className="hero">
          <span className="eyebrow">Comparison</span>
          <h1>No such recording</h1>
        </section>
        {form}
        <ErrorState title="No such recording" code="UNKNOWN_SAMPLE">
          Nothing is bundled under <code className="inline-code">{missing}</code>. The bundled recordings are{' '}
          {options.map((option) => option.id).join(', ')} — or{' '}
          <Link href="/">paste your own on the home page</Link>.
        </ErrorState>
      </div>
    )
  }

  const result = compare(base, head)

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Comparison</span>
        <h1>
          {options.find((option) => option.id === baseId)?.label ?? baseId} against{' '}
          {options.find((option) => option.id === headId)?.label ?? headId}
        </h1>
      </section>
      {form}
      {result.ok ? (
        result.report.rows.length === 0 ? (
          <EmptyState title="Both recordings are empty">
            There are no spans to compare. A recording needs at least one span with a{' '}
            <code className="inline-code">span_id</code>, a <code className="inline-code">name</code> and a{' '}
            <code className="inline-code">dur_ns</code>.
          </EmptyState>
        ) : (
          <ReportView report={result.report} />
        )
      ) : (
        <ErrorState title="That comparison was refused" code={result.code}>
          {result.message}
        </ErrorState>
      )}
    </div>
  )
}
