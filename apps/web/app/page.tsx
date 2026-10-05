import Link from 'next/link'
import { defaultComparison, sampleOptions } from '@/lib/data'
import { ReportView } from '@/components/ReportView'
import { EmptyState } from '@/components/states'
import { PasteDiff } from '@/components/PasteDiff'
import { PRODUCT } from '@/lib/product'

/**
 * The landing page, and the product's primary interaction: a form.
 *
 * Not a chat box and not a dashboard — a form. This is a tool for comparing two artefacts, so
 * the interface is two inputs and a submit. The sample comparison is computed during render so
 * the first paint already contains real product data rather than a skeleton; a reader who
 * never touches the form still sees what the thing does.
 */
export default function HomePage() {
  const options = sampleOptions()
  const comparison = defaultComparison()
  const report = comparison?.ok === true ? comparison.report : null

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">v{PRODUCT.version}</span>
        <h1>What actually changed, and can you prove it?</h1>
        <p>{PRODUCT.tagline}</p>
      </section>

      <form className="compare-form" action="/compare" method="get">
        <div className="compare-form__row">
          <div className="field">
            <label htmlFor="base">Before</label>
            <select id="base" name="base" defaultValue="before">
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="field__hint">The recording from before the change.</span>
          </div>

          <div className="field">
            <label htmlFor="head">After</label>
            <select id="head" name="head" defaultValue="after">
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="field__hint">The recording from after the change.</span>
          </div>
        </div>

        <button className="button" type="submit">
          Compare
        </button>
      </form>

      {report !== null ? (
        <ReportView report={report} />
      ) : (
        <EmptyState title="Nothing to compare yet">
          Pick a pair of recordings above, or paste your own below.
        </EmptyState>
      )}

      <section className="panel">
        <h2 className="panel__title">Your own recordings</h2>
        <p className="field__hint">
          Paste a recording as JSON. It goes to <code className="inline-code">/api/diff</code> — the same API
          the CLI and the MCP server speak — and is compared by the same engine.
        </p>
        <PasteDiff />
      </section>

      <section className="panel">
        <h2 className="panel__title">Why the numbers can be trusted</h2>
        <ul>
          <li>
            The comparison is a <strong>minimal edit script</strong> over the recordings&apos; token streams,
            proved minimal against a brute-force oracle — not a visual similarity score.
          </li>
          <li>
            Every recording is rebuilt from its own tokens and checked byte-for-byte. The verdict is shown
            above the report, not buried in a footer.
          </li>
          <li>
            The same code answers the CLI, this page, and any MCP client. There is no second implementation to
            disagree.
          </li>
        </ul>
        <p className="field__hint">
          <Link href="/health">Check what this deployment is actually running</Link>, or compare the bundled
          pair at <Link href="/compare?base=before&amp;head=after">/compare</Link>.
        </p>
      </section>
    </div>
  )
}
