import type { Report } from '@flamediff/tracekit'
import { Timeline, TimelineLegend } from './Timeline'

/**
 * The whole report: aggregate numbers, the faithfulness verdict, per-column movement, and the
 * timeline. Ordered so the verdict sits above the numbers — a comparison that cannot be proved
 * faithful should be read with that caveat before its contents, not after.
 */
export function ReportView({ report }: { readonly report: Report }) {
  const { stats } = report
  const changed = stats.added + stats.removed + stats.renamed + stats.depth_shifted + stats.duration_regressed

  return (
    <div className="stack">
      <Notice
        tone={report.roundtrip.lossless ? 'ok' : 'danger'}
        title={report.roundtrip.lossless ? 'Comparison proved faithful' : 'Round trip FAILED'}
      >
        {report.roundtrip.lossless ? (
          <>
            Both recordings were rebuilt from their own token streams and came back byte-identical, so the{' '}
            {report.edit_cost}-token edit script below is a statement about the work — not about
            serialisation.
          </>
        ) : (
          <>
            A recording did not survive its own token stream. Treat every number below as unreliable and
            re-export the recordings.
          </>
        )}
      </Notice>

      <div className="stat-row">
        <Stat label="slower" value={stats.duration_regressed} tone="regressed" />
        <Stat label="faster" value={stats.duration_improved} tone="added" />
        <Stat label="added" value={stats.added} tone="added" />
        <Stat label="removed" value={stats.removed} />
        <Stat label="renamed" value={stats.renamed} />
        <Stat label="edit cost" value={report.edit_cost} />
      </div>

      <section className="panel">
        <div>
          <h2 className="panel__title">
            {report.base.label || report.base.trace_id} against {report.head.label || report.head.trace_id}
          </h2>
          <p className="field__hint">
            {report.base.span_count} spans against {report.head.span_count} spans —{' '}
            {changed === 0 ? 'no differences' : `${changed} difference${changed === 1 ? '' : 's'} to look at`}
            {stats.orphans > 0 ? `, ${stats.orphans} detached span(s) reported` : ''}
          </p>
        </div>

        <Timeline report={report} />
        <TimelineLegend />
      </section>

      <section className="panel">
        <h2 className="panel__title">Which columns moved</h2>
        <p className="field__hint">
          Recordings are stored one column per attribute, and spans are matched by{' '}
          <code className="inline-code">span_id</code> — so an inserted span does not report every column
          beneath it as changed.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">column</th>
              <th scope="col">added</th>
              <th scope="col">removed</th>
              <th scope="col">changed</th>
              <th scope="col">unchanged</th>
            </tr>
          </thead>
          <tbody>
            {report.column_deltas.map((delta) => (
              <tr key={delta.column}>
                <td>{delta.column}</td>
                <td>{delta.added}</td>
                <td>{delta.removed}</td>
                <td>{delta.changed}</td>
                <td>{delta.unchanged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string
  readonly value: number
  readonly tone?: 'regressed' | 'added' | 'ok' | 'danger'
}) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  )
}

function Notice({
  tone,
  title,
  children,
}: {
  readonly tone: 'ok' | 'warn' | 'danger'
  readonly title: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="notice" data-tone={tone} role={tone === 'ok' ? undefined : 'alert'}>
      <strong>{title}.</strong>
      <span>{children}</span>
    </div>
  )
}
