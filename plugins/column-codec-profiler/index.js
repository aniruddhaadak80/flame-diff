/**
 * `column-codec-profiler` — a column codec extension.
 *
 * The core container (`FLDC`) stores one column per attribute, which is what lets the product
 * answer "which attributes moved". This plugin adds the complementary question: how many bytes
 * is each column actually costing, so you can tell whether the expensive column is `name` or
 * the cheap one is `dur_ns`.
 *
 * It claims `column.encoding-costs` at priority 40. Priority resolves contested capabilities
 * deterministically and reports the loser, so adding a second codec plugin later will not
 * silently replace this one.
 *
 * Byte lengths are measured in UTF-8, matching how the container measures them — a codec that
 * counted code points would disagree with the file it claims to describe.
 */

const encoder = new TextEncoder()

/** The columns the container declares, in storage order. */
export const COLUMNS = ['span_id', 'parent_id', 'name', 'start_ns', 'dur_ns', 'depth']

/**
 * @typedef {object} ColumnCost
 * @property {string} column
 * @property {number} bytes
 * @property {number} share
 */

/**
 * @typedef {object} EncodingReport
 * @property {number} spanCount
 * @property {number} totalBytes
 * @property {ColumnCost[]} columns
 */

/**
 * Account for the bytes each column costs.
 *
 * Numbers cost their decimal length, because that is what the line-oriented container writes.
 * Strings cost their UTF-8 length, because that is what the container stores. Counting
 * characters instead would under-report every non-ASCII name.
 *
 * @param {Array<object>} spans
 * @returns {EncodingReport}
 */
export function profile(spans) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return { spanCount: 0, totalBytes: 0, columns: [] }
  }

  const bytes = new Map(COLUMNS.map((column) => [column, 0]))

  for (const span of spans) {
    add(bytes, 'span_id', encoder.encode(String(span.span_id ?? span.spanId ?? '')).length)
    add(bytes, 'parent_id', encoder.encode(String(span.parent_id ?? span.parentId ?? '')).length)
    add(bytes, 'name', encoder.encode(String(span.name ?? '')).length)
    add(bytes, 'start_ns', String(span.start_ns ?? span.startNs ?? 0).length)
    add(bytes, 'dur_ns', String(span.dur_ns ?? span.durNs ?? 0).length)
    // depth is derived rather than stored on the span; it costs one digit per level.
    add(bytes, 'depth', 1)
  }

  const totalBytes = [...bytes.values()].reduce((sum, value) => sum + value, 0)
  const columns = COLUMNS.map((column) => {
    const columnBytes = bytes.get(column) ?? 0
    return {
      column,
      bytes: columnBytes,
      share: totalBytes === 0 ? 0 : columnBytes / totalBytes,
    }
  })

  return { spanCount: spans.length, totalBytes, columns }
}

/**
 * @param {Map<string, number>} bytes
 * @param {string} column
 * @param {number} amount
 */
function add(bytes, column, amount) {
  bytes.set(column, (bytes.get(column) ?? 0) + amount)
}

/**
 * The column worth looking at first: the biggest one.
 *
 * @param {EncodingReport} report
 * @returns {ColumnCost}
 */
export function heaviest(report) {
  return report.columns.reduce((max, column) => (column.bytes > max.bytes ? column : max), {
    column: 'none',
    bytes: 0,
    share: 0,
  })
}
