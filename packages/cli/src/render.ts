import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Report, Row } from '@flamediff/tracekit'
import type { ChangeStatus } from '@flamediff/tracekit'

/**
 * Rendering the report for a terminal.
 *
 * The depth ruler is the product's signature, so it appears here too: a run of tick marks
 * whose length is the span's depth. An insertion shows as a gap, a depth shift as a step, a
 * removal as a struck-through rule. That is the same shape the web timeline draws, so a CLI
 * screenshot and a browser screenshot are recognisably the same product.
 */

const GLYPH: Record<ChangeStatus, string> = {
  added: '+',
  removed: '-',
  renamed: '~',
  depth_shifted: '>',
  duration_regressed: '!',
  duration_improved: 'v',
  reordered: '>',
  duration_changed: '.',
  unchanged: ' ',
}

const WIDTH = 74

export function ruler(depth: number): string {
  return '|'.repeat(depth) + (depth === 0 ? '|' : '')
}

export function ns(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}ms`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}us`
  return `${value}ns`
}

export function signedNs(value: number): string {
  return `${value > 0 ? '+' : ''}${ns(Math.abs(value))}`
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)}~` : text.padEnd(width)
}

function percent(row: Row): string {
  if (row.delta_bps === null) return ''
  const sign = row.delta_bps > 0 ? '+' : ''
  return `${sign}${(row.delta_bps / 100).toFixed(1)}%`
}

/** The single-column timeline: one row per span, in the order the stack actually ran. */
export function renderTimeline(report: Report, changedOnly = false): string {
  const rows = changedOnly ? report.rows.filter((row) => row.status !== 'unchanged') : report.rows
  if (rows.length === 0) {
    return changedOnly ? 'no changes between these two recordings' : 'no spans in this recording'
  }

  const max = maxDuration(rows)
  const lines: string[] = []
  for (const row of rows) {
    const head = row.head_dur_ns ?? row.base_dur_ns ?? 0
    const fill = bar(head, max)
    const name = pad(row.name, 30)
    const delta = row.delta_ns === null ? '' : signedNs(row.delta_ns)
    lines.push(
      `${GLYPH[row.status]} ${pad(ruler(row.depth), 10)}${pad(name, 32)}${pad(ns(head), 11)}` +
        `${pad(delta, 11)}${pad(percent(row), 9)}${fill}  ${row.span_id}`,
    )
  }
  return lines.join('\n')
}

function maxDuration(rows: readonly Row[]): number {
  let max = 0
  for (const row of rows) {
    max = Math.max(max, row.head_dur_ns ?? 0, row.base_dur_ns ?? 0)
  }
  return max === 0 ? 1 : max
}

function bar(value: number, max: number): string {
  const filled = Math.min(WIDTH, Math.round((value / max) * WIDTH))
  return '#'.repeat(Math.max(filled, value > 0 ? 1 : 0))
}

export function renderSummary(report: Report): string {
  const stats = report.stats
  const changed = stats.added + stats.removed + stats.renamed + stats.depth_shifted + stats.duration_regressed
  return [
    `${report.base.label || report.base.trace_id} (${report.base.span_count} spans)`,
    `vs`,
    `${report.head.label || report.head.trace_id} (${report.head.span_count} spans)`,
    '',
    `  ${stats.duration_regressed} regressed   ${stats.duration_improved} improved`,
    `  ${stats.added} added         ${stats.removed} removed`,
    `  ${stats.renamed} renamed      ${stats.depth_shifted} depth-shifted`,
    `  ${stats.unchanged} unchanged`,
    '',
    `  edit cost        ${report.edit_cost} token(s) — minimal edit script`,
    `  round trip       ${report.roundtrip.lossless ? 'verified lossless' : 'FAILED'}`,
    `  orphans          ${stats.orphans}`,
    changed === 0
      ? '  verdict: these recordings are equivalent'
      : `  verdict: ${changed} change(s) to look at`,
  ].join('\n')
}

export function renderColumnDeltas(deltas: Report['column_deltas']): string {
  const width = Math.max(...deltas.map((delta) => delta.column.length), 6)
  return deltas
    .map(
      (delta) =>
        `  ${delta.column.padEnd(width)}  +${delta.added}  -${delta.removed}  ` +
        `~${delta.changed}  =${delta.unchanged}`,
    )
    .join('\n')
}

export function renderHunks(report: Report): string {
  return report.hunks
    .map((hunk) => {
      const tokens = hunk.tokens.slice(0, 12).join(' ')
      const more = hunk.tokens.length > 12 ? ` … (+${hunk.tokens.length - 12})` : ''
      return (
        `  ${hunk.op.padEnd(6)} base@${String(hunk.base_start).padStart(4)}+${hunk.base_len}  ` +
        `head@${String(hunk.head_start).padStart(4)}+${hunk.head_len}  ${tokens}${more}`
      )
    })
    .join('\n')
}

/** Read a recording from a file: `.fld` container text, or a JSON trace document. */
export function readTraceFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8')
  if (path.endsWith('.fld') || raw.startsWith('FLDC1')) return { container: raw }
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new Error(`${basename(path)} is neither FLDC container text nor JSON: ${String(cause)}`)
  }
}
