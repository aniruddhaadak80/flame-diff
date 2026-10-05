/**
 * The columnar storage container, mirrored from `services/engine/src/flame_diff/columns.py`.
 *
 * A recording is stored one column per attribute rather than one row per span, which is why
 * the product can answer "which columns changed?" — a question a row store answers only by
 * scanning and comparing field by field.
 *
 * Cells are separated by TAB, not space: `escape` turns every tab into the two characters
 * `\t`, so a raw tab can never appear inside a quoted cell, and any span name containing a
 * space stays unambiguous.
 *
 * `depth` is stored even though it is derived, so the container is readable without
 * replaying the tree. `decode` re-derives it and refuses a container whose stored depth
 * contradicts its own tree — corruption fails loudly instead of rendering a wrong tree.
 */

import { depthsOf, order } from './canonical.js'
import { escape, unescape } from './escape.js'
import { COLUMNS, EngineError, FLDC_MAGIC, type Span, type Trace } from './types.js'

export const DTYPE_U64 = 'u64'
export const DTYPE_STR = 'str'
export const SEPARATOR = '\t'

const DTYPES: ReadonlySet<string> = new Set([DTYPE_U64, DTYPE_STR])

const U64_COLUMNS: ReadonlySet<string> = new Set(['start_ns', 'dur_ns', 'depth'])

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Every column's values, in canonical pre-order. */
function columnValues(trace: Trace): Record<string, Array<string | number>> {
  const ordered = order(trace)
  const byId = new Map(trace.spans.map((span) => [span.span_id, span]))
  const depths = depthsOf(trace.spans)
  return {
    span_id: ordered,
    parent_id: ordered.map((id) => byId.get(id)?.parent_id ?? ''),
    name: ordered.map((id) => byId.get(id)?.name ?? ''),
    start_ns: ordered.map((id) => byId.get(id)?.start_ns ?? 0),
    dur_ns: ordered.map((id) => byId.get(id)?.dur_ns ?? 0),
    depth: ordered.map((id) => depths.get(id) ?? 0),
  }
}

export function encode(trace: Trace): string {
  const values = columnValues(trace)
  const count = values['span_id']?.length ?? 0
  const lines: string[] = [
    FLDC_MAGIC,
    `trace ${escape(trace.trace_id)}`,
    `label ${escape(trace.label)}`,
    `spans ${count}`,
    `columns ${COLUMNS.length}`,
  ]
  for (const column of COLUMNS) {
    const dtype = U64_COLUMNS.has(column) ? DTYPE_U64 : DTYPE_STR
    const cells = values[column] ?? []
    lines.push(`${column} ${dtype} ${count}`)
    if (count === 0) {
      lines.push('')
      continue
    }
    lines.push(
      cells
        .map((cell) => (dtype === DTYPE_STR ? escape(String(cell)) : String(Math.trunc(Number(cell)))))
        .join(SEPARATOR),
    )
  }
  return `${lines.join('\n')}\n`
}

export function decode(text: string): Trace {
  // CRLF input is accepted. The container is *written* with LF endings, but a file that has
  // been through a Windows checkout or a text editor will carry CRLF, and refusing it would
  // make the format fail on the platform most likely to touch it.
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0 || lines[0] !== FLDC_MAGIC) {
    throw new EngineError('BAD_MAGIC', `expected ${FLDC_MAGIC} on the first line`)
  }

  let cursor = 1
  const header = (field: string): string => {
    if (cursor >= lines.length) {
      throw new EngineError('TRUNCATED', `missing the '${field}' header`)
    }
    const line = lines[cursor] as string
    cursor += 1
    const separator = line.indexOf(' ')
    if (separator === -1 || line.slice(0, separator) !== field) {
      throw new EngineError('BAD_HEADER', `expected a '${field}' header, got ${JSON.stringify(line)}`)
    }
    return line.slice(separator + 1)
  }

  const traceId = unescape(header('trace'))
  const label = unescape(header('label'))
  const declaredCount = header('spans')
  if (!/^\d+$/.test(declaredCount)) {
    throw new EngineError('BAD_HEADER', `'spans' must be a count, got ${JSON.stringify(declaredCount)}`)
  }
  const declaredColumns = header('columns')
  if (!/^\d+$/.test(declaredColumns) || Number(declaredColumns) !== COLUMNS.length) {
    throw new EngineError(
      'UNSUPPORTED_COLUMNS',
      `this build reads exactly ${COLUMNS.length} columns, container declares ${declaredColumns}`,
    )
  }

  const columns = new Map<string, Array<string | number>>()
  for (let index = 0; index < COLUMNS.length; index += 1) {
    if (cursor >= lines.length) {
      throw new EngineError('TRUNCATED', 'container ends before every column is declared')
    }
    const headerLine = lines[cursor] as string
    cursor += 1
    const parts = headerLine.split(' ')
    if (parts.length !== 3) {
      throw new EngineError('BAD_HEADER', `malformed column header ${JSON.stringify(headerLine)}`)
    }
    const [name, dtype, rawCount] = parts as [string, string, string]
    if (!(COLUMNS as readonly string[]).includes(name)) {
      throw new EngineError('UNKNOWN_COLUMN', `unknown column '${name}'`)
    }
    if (columns.has(name)) {
      throw new EngineError('DUPLICATE_COLUMN', `column '${name}' appears twice`)
    }
    if (!DTYPES.has(dtype)) {
      throw new EngineError('UNKNOWN_DTYPE', `unsupported dtype '${dtype}' for column '${name}'`)
    }
    if (!/^\d+$/.test(rawCount)) {
      throw new EngineError('BAD_HEADER', `column '${name}' has a non-numeric count '${rawCount}'`)
    }

    const count = Number(rawCount)
    if (cursor >= lines.length) {
      throw new EngineError('TRUNCATED', `column '${name}' has no values`)
    }
    const row = lines[cursor] as string
    cursor += 1
    if (count === 0) {
      if (row !== '') {
        throw new EngineError('BAD_ROW', `column '${name}' is empty but carries values`)
      }
      columns.set(name, [])
      continue
    }
    const cells = row.split(SEPARATOR)
    if (cells.length !== count) {
      throw new EngineError(
        'BAD_ROW',
        `column '${name}' declares ${count} values but the row has ${cells.length}`,
      )
    }
    columns.set(
      name,
      cells.map((cell) => cellFor(dtype, cell, name)),
    )
  }

  if (cursor !== lines.length) {
    throw new EngineError('TRAILING_DATA', `${lines.length - cursor} unread line(s) after the columns`)
  }

  const spans = spansFrom(columns)
  const trace: Trace = { trace_id: traceId, label, spans }
  assertDepthAgrees(trace, columns.get('depth') ?? [])
  return trace
}

function cellFor(dtype: string, cell: string, column: string): string | number {
  if (dtype === DTYPE_STR) return unescape(cell)
  if (!/^\d+$/.test(cell)) {
    throw new EngineError(
      'BAD_CELL',
      `column '${column}' expects an unsigned integer, got ${JSON.stringify(cell)}`,
    )
  }
  return Number(cell)
}

function spansFrom(columns: Map<string, Array<string | number>>): Span[] {
  const ids = (columns.get('span_id') ?? []).map(String)
  const parents = (columns.get('parent_id') ?? []).map(String)
  const names = (columns.get('name') ?? []).map(String)
  const starts = (columns.get('start_ns') ?? []).map(Number)
  const durations = (columns.get('dur_ns') ?? []).map(Number)

  if (new Set(ids).size !== ids.length) {
    throw new EngineError('DUPLICATE_SPAN_ID', 'span_id column has a repeated value')
  }
  const known = new Set(ids)

  const spans: Span[] = []
  ids.forEach((spanId, index) => {
    const parent = parents[index] ?? ''
    if (parent !== '' && !known.has(parent)) {
      throw new EngineError(
        'DANGLING_PARENT',
        `span '${spanId}' names parent '${parent}', which is not in the container`,
      )
    }
    spans.push({
      span_id: spanId,
      parent_id: parent === '' ? null : parent,
      name: names[index] ?? '',
      start_ns: starts[index] ?? 0,
      dur_ns: durations[index] ?? 0,
    })
  })
  return spans
}

function assertDepthAgrees(trace: Trace, stored: Array<string | number>): void {
  const derived = depthsOf(trace.spans)
  trace.spans.forEach((span, index) => {
    const expected = derived.get(span.span_id) ?? 0
    const actual = Number(stored[index])
    if (expected !== actual) {
      throw new EngineError(
        'DEPTH_MISMATCH',
        `column depth says ${actual} for span '${span.span_id}', but the tree says ${expected}`,
      )
    }
  })
}

/**
 * Per-column deltas: how each attribute moved between two recordings.
 *
 * Spans are matched by `span_id`, so a column delta is a statement about the same spans the
 * report lists. Without id matching, a span inserted near the top of the tree would report
 * every column below it as changed.
 */
export function columnDeltas(
  base: Trace,
  head: Trace,
): Array<{
  column: string
  added: number
  removed: number
  changed: number
  unchanged: number
}> {
  const baseById = new Map(base.spans.map((span) => [span.span_id, span]))
  const headById = new Map(head.spans.map((span) => [span.span_id, span]))
  const baseDepths = depthsOf(base.spans)
  const headDepths = depthsOf(head.spans)

  const added = [...headById.keys()].filter((id) => !baseById.has(id)).length
  const removed = [...baseById.keys()].filter((id) => !headById.has(id)).length
  const shared = [...headById.keys()].filter((id) => baseById.has(id))

  return COLUMNS.map((column) => {
    let changed = 0
    let unchanged = 0
    for (const spanId of shared) {
      const left = valueOf(baseById.get(spanId), column, baseDepths)
      const right = valueOf(headById.get(spanId), column, headDepths)
      if (left === right) unchanged += 1
      else changed += 1
    }
    return { column, added, removed, changed, unchanged }
  })
}

function valueOf(
  span: Span | undefined,
  column: string,
  depths: Map<string, number>,
): string | number | null {
  if (span === undefined) return null
  if (column === 'span_id') return span.span_id
  if (column === 'depth') return depths.get(span.span_id) ?? 0
  if (column === 'parent_id') return span.parent_id ?? ''
  if (column === 'name') return span.name
  if (column === 'start_ns') return span.start_ns
  return span.dur_ns
}

export { byteLength }
