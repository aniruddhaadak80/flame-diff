import type { Report, Row } from '@flamediff/tracekit'
import { formatBps, signedNs } from '@/lib/format'
import { Duration } from './Duration'

/**
 * The signature element: a single-column timeline with a depth ruler on every row.
 *
 * Why one column and not two side-by-side flame graphs: a diff is read top to bottom. Putting
 * the recordings next to each other makes the reader do the alignment, which is precisely the
 * work this tool exists to do. Emitting one row per span, in the order the stack actually ran,
 * means the comparison is already done by the time it reaches the page.
 *
 * The ruler is the identifying mark. One tick per level of depth, so an added span reads as a
 * gap in the staircase, a re-parented span as a step, and a removed span as a struck-through
 * rule — the shape of the change is legible before a single word is read.
 *
 * This is a server component apart from the numbers, which count up. The markup is complete
 * on first paint.
 */

const MAX_TICKS = 12

function tone(row: Row): 'regressed' | 'improved' | 'flat' {
  if (row.delta_ns === null || row.delta_ns === 0) return 'flat'
  return row.delta_ns > 0 ? 'regressed' : 'improved'
}

function barTone(row: Row): 'regressed' | 'added' | 'removed' | 'normal' {
  if (row.status === 'added') return 'added'
  if (row.status === 'removed') return 'removed'
  return row.status === 'duration_regressed' ? 'regressed' : 'normal'
}

function Ruler({ row }: { readonly row: Row }) {
  const ticks: number[] = []
  for (let depth = 0; depth < Math.min(row.depth, MAX_TICKS); depth += 1) ticks.push(depth)
  if (row.depth > MAX_TICKS) ticks.push(MAX_TICKS)

  return (
    <span className="ruler" aria-hidden="true">
      {ticks.map((depth) => (
        <span
          className="ruler__tick"
          key={depth}
          data-last={depth === ticks.length - 1}
          data-removed={row.status === 'removed'}
          data-shifted={row.flags.includes('depth_shifted')}
        />
      ))}
    </span>
  )
}

export function Timeline({ report }: { readonly report: Report }) {
  const peak = report.rows.reduce((max, row) => {
    const value = row.head_dur_ns ?? row.base_dur_ns ?? 0
    return value > max ? value : max
  }, 0)

  if (report.rows.length === 0) return null

  return (
    <div className="timeline" role="list">
      {report.rows.map((row) => {
        const duration = row.head_dur_ns ?? row.base_dur_ns ?? 0
        const width = peak === 0 ? 0 : Math.max(1, (duration / peak) * 100)
        return (
          <div
            className="timeline__row"
            key={`${row.span_id}-${row.status}`}
            role="listitem"
            data-status={row.status}
            data-span={row.span_id}
          >
            <Ruler row={row} />

            <span className="timeline__name" title={row.name}>
              {row.name}
            </span>

            <Duration value={duration} emphasis="strong" />

            <span className="timeline__num timeline__delta" data-tone={tone(row)}>
              {row.delta_ns === null ? '' : signedNs(row.delta_ns)}
            </span>

            <span className="timeline__num" title={`span ${row.span_id} at depth ${row.depth}`}>
              {row.delta_bps === null ? '' : formatBps(row.delta_bps)}
            </span>

            <span className="bar">
              <span className="bar__fill" data-tone={barTone(row)} style={{ width: `${width}%` }} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function TimelineLegend() {
  return (
    <p className="legend">
      <span className="legend__item">
        <span className="legend__swatch" /> unchanged
      </span>
      <span className="legend__item">
        <span className="legend__swatch" data-tone="regressed" /> slower
      </span>
      <span className="legend__item">
        <span className="legend__swatch" data-tone="added" /> added
      </span>
      <span className="legend__item">
        <span className="legend__swatch" data-tone="removed" /> removed
      </span>
      <span className="legend__item">ruler ticks = stack depth</span>
    </p>
  )
}
