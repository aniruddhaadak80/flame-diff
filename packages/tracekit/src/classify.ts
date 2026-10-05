/**
 * Turning two recordings into one report, mirrored from
 * `services/engine/src/flame_diff/classify.py`.
 *
 * Two views of the same change, because they answer different questions:
 *   * the token edit script is structural and provably minimal — the proof that the
 *     comparison touched as little as possible;
 *   * this module is semantic — what actually happened to the work.
 *
 * Spans are matched by `span_id`, which is what a recorder can keep stable across two runs,
 * so a renamed function is reported as a rename rather than a removal plus an unrelated
 * addition. Removals are spliced back into the head recording's position using the
 * canonical path key, so the timeline reads top to bottom the way the stack actually did.
 *
 * Every threshold that decides a status is passed in. Nothing here reads a clock.
 */

import { compareKeys, order, paths, type SortKey } from './canonical.js'
import type { ChangeStatus, Row, Span, Stats, Trace } from './types.js'

export const STATUS_ADDED: ChangeStatus = 'added'
export const STATUS_REMOVED: ChangeStatus = 'removed'
export const STATUS_RENAMED: ChangeStatus = 'renamed'
export const STATUS_DEPTH_SHIFTED: ChangeStatus = 'depth_shifted'
export const STATUS_REGRESSED: ChangeStatus = 'duration_regressed'
export const STATUS_IMPROVED: ChangeStatus = 'duration_improved'
export const STATUS_REORDERED: ChangeStatus = 'reordered'
export const STATUS_DURATION_CHANGED: ChangeStatus = 'duration_changed'
export const STATUS_UNCHANGED: ChangeStatus = 'unchanged'

/**
 * Highest-precedence first. The `status` of a row is the first flag that applies; `flags`
 * keeps all of them, so nothing is lost by showing one.
 *
 * `reordered` is deliberately NOT here. Canonical sibling order is decided by
 * (name, start_ns, span_id), so two spans that both survive can never trade places on their
 * own — a span only moves because it was renamed. Reporting "reordered" as a primary status
 * would name a symptom as the cause. It is kept as a flag, where it says something useful:
 * this span also moved position among its siblings.
 */
const PRECEDENCE: readonly ChangeStatus[] = [
  STATUS_RENAMED,
  STATUS_DEPTH_SHIFTED,
  STATUS_REGRESSED,
  STATUS_IMPROVED,
  STATUS_DURATION_CHANGED,
  STATUS_UNCHANGED,
]

/**
 * Basis points of change, as an integer, so the two languages cannot disagree over floats.
 *
 * Rounds toward NEGATIVE infinity, matching Python's `//`. JavaScript's `Math.trunc` and
 * `Math.floor` differ for negative values (-882 vs -883 for a 600 ns drop on 6800 ns), and
 * `Math.floor(delta * 10000 / base)` is not reliably the same as integer floor division once
 * the float multiply rounds. So the division is done exactly, in BigInt.
 *
 * A regression always rounds down, i.e. understates how much worse things got; an
 * improvement rounds down too, i.e. understates how much better. Both err towards "less
 * dramatic", which is the right direction for a report someone acts on.
 */
function bps(deltaNs: number, baseNs: number): number | null {
  if (baseNs <= 0) return null
  const numerator = BigInt(deltaNs) * 10_000n
  const denominator = BigInt(baseNs)
  let quotient = numerator / denominator
  if (numerator % denominator !== 0n && numerator < 0n) quotient -= 1n
  return Number(quotient)
}

/**
 * Position of each span among its ordered siblings, in canonical order.
 *
 * `restrictTo` limits the count to spans present in both recordings. Without it, deleting a
 * span shifts every later sibling up by one and the report calls that a reordering — an
 * artefact of the deletion, not a change in the work. Both recordings are therefore indexed
 * against the same surviving set, so a `reordered` flag always means a span genuinely moved
 * relative to the spans it still competes with.
 */
function ordinals(trace: Trace, restrictTo?: ReadonlySet<string>): Map<string, number> {
  const byId = new Map(trace.spans.map((span) => [span.span_id, span]))
  const ordered = order(trace).filter((id) => restrictTo === undefined || restrictTo.has(id))

  const buckets = new Map<string, string[]>()
  const roots: string[] = []
  for (const spanId of ordered) {
    const parent = byId.get(spanId)?.parent_id
    if (parent === null || parent === undefined || !byId.has(parent)) {
      roots.push(spanId)
      continue
    }
    const bucket = buckets.get(parent)
    if (bucket === undefined) buckets.set(parent, [spanId])
    else bucket.push(spanId)
  }

  const result = new Map<string, number>()
  for (const spanId of ordered) {
    const parent = byId.get(spanId)?.parent_id
    const siblings =
      parent === null || parent === undefined || !byId.has(parent) ? roots : (buckets.get(parent) ?? [])
    result.set(spanId, siblings.indexOf(spanId))
  }
  return result
}

interface RemovedRef {
  readonly key: SortKey[]
  readonly id: string
}

export function classify(
  base: Trace,
  head: Trace,
  regressionRatio = 1.25,
  minDurationNs = 0,
): { rows: Row[]; stats: Stats } {
  const baseById = new Map(base.spans.map((span) => [span.span_id, span]))
  const headById = new Map(head.spans.map((span) => [span.span_id, span]))

  const basePaths = paths(base)
  const headPaths = paths(head)
  const baseDepths = new Map([...basePaths].map(([id, key]) => [id, key.length - 1]))
  const headDepths = new Map([...headPaths].map(([id, key]) => [id, key.length - 1]))

  const surviving = new Set([...baseById.keys()].filter((id) => headById.has(id)))
  const baseOrdinals = ordinals(base, surviving)
  const headOrdinals = ordinals(head, surviving)

  const headOrder = order(head)
  const removed: RemovedRef[] = order(base)
    .filter((id) => !headById.has(id))
    .map((id) => ({ key: basePaths.get(id) ?? [], id }))
    .sort((a, b) => compareKeys(a.key, b.key))

  const rows: Row[] = []
  let cursor = 0

  const removedRow = (gone: Span): Row => ({
    span_id: gone.span_id,
    name: gone.name,
    depth: baseDepths.get(gone.span_id) ?? 0,
    status: STATUS_REMOVED,
    flags: [STATUS_REMOVED],
    base_dur_ns: gone.dur_ns,
    head_dur_ns: null,
    delta_ns: null,
    delta_bps: null,
    base_depth: baseDepths.get(gone.span_id) ?? null,
  })

  for (const spanId of headOrder) {
    const headKey = headPaths.get(spanId) ?? []
    while (cursor < removed.length && compareKeys((removed[cursor] as RemovedRef).key, headKey) < 0) {
      const gone = baseById.get((removed[cursor] as RemovedRef).id)
      if (gone !== undefined) rows.push(removedRow(gone))
      cursor += 1
    }
    const headSpan = headById.get(spanId) as Span
    rows.push(
      row(
        baseById.get(spanId),
        headSpan,
        baseDepths.get(spanId) ?? null,
        headDepths.get(spanId) ?? 0,
        baseOrdinals.get(spanId),
        headOrdinals.get(spanId),
        regressionRatio,
        minDurationNs,
      ),
    )
  }

  while (cursor < removed.length) {
    const gone = baseById.get((removed[cursor] as RemovedRef).id)
    if (gone !== undefined) rows.push(removedRow(gone))
    cursor += 1
  }

  return { rows, stats: statsOf(rows) }
}

function row(
  base: Span | undefined,
  head: Span,
  baseDepth: number | null,
  headDepth: number,
  baseOrdinal: number | undefined,
  headOrdinal: number | undefined,
  regressionRatio: number,
  minDurationNs: number,
): Row {
  if (base === undefined) {
    return {
      span_id: head.span_id,
      name: head.name,
      depth: headDepth,
      status: STATUS_ADDED,
      flags: [STATUS_ADDED],
      base_dur_ns: null,
      head_dur_ns: head.dur_ns,
      delta_ns: null,
      delta_bps: null,
      base_depth: null,
    }
  }

  const flags: ChangeStatus[] = []
  const deltaNs = head.dur_ns - base.dur_ns
  const baseDur = base.dur_ns

  if (base.name !== head.name) flags.push(STATUS_RENAMED)
  if (baseDepth !== null && baseDepth !== headDepth) flags.push(STATUS_DEPTH_SHIFTED)
  if (baseOrdinal !== undefined && headOrdinal !== undefined && baseOrdinal !== headOrdinal) {
    flags.push(STATUS_REORDERED)
  }

  if (deltaNs === 0 || Math.max(baseDur, head.dur_ns) < minDurationNs) {
    flags.push(STATUS_UNCHANGED)
  } else if (baseDur > 0 && head.dur_ns >= baseDur * regressionRatio) {
    flags.push(STATUS_REGRESSED)
  } else if (head.dur_ns > 0 && baseDur >= head.dur_ns * regressionRatio) {
    flags.push(STATUS_IMPROVED)
  } else {
    flags.push(STATUS_DURATION_CHANGED)
  }

  const status = PRECEDENCE.find((candidate) => flags.includes(candidate)) ?? STATUS_UNCHANGED

  return {
    span_id: head.span_id,
    name: head.name,
    depth: headDepth,
    status,
    flags,
    base_dur_ns: baseDur,
    head_dur_ns: head.dur_ns,
    delta_ns: deltaNs,
    delta_bps: bps(deltaNs, baseDur),
    base_depth: baseDepth,
  }
}

export function statsOf(rows: readonly Row[]): Stats {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  let reordered = 0
  for (const row of rows) if (row.flags.includes(STATUS_REORDERED)) reordered += 1

  return {
    total_rows: rows.length,
    added: counts.get(STATUS_ADDED) ?? 0,
    removed: counts.get(STATUS_REMOVED) ?? 0,
    renamed: counts.get(STATUS_RENAMED) ?? 0,
    depth_shifted: counts.get(STATUS_DEPTH_SHIFTED) ?? 0,
    duration_regressed: counts.get(STATUS_REGRESSED) ?? 0,
    duration_improved: counts.get(STATUS_IMPROVED) ?? 0,
    // Counted as a flag, because it is never a primary status.
    reordered,
    unchanged: counts.get(STATUS_UNCHANGED) ?? 0,
    orphans: 0,
  }
}
