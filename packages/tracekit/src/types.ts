/**
 * The typed I/O contract, mirrored from `services/engine/src/flame_diff/model.py`.
 *
 * This package is a PORT of the Python reference engine, not a second implementation of the
 * product. It exists because Vercel runs the web app in a Node function with no Python
 * runtime, and a diff viewer that cannot compute a diff is a screenshot. The port is kept
 * honest by `golden.test.ts`, which asserts the exact same `fixtures/golden/cases.json` that
 * `services/engine/tests/test_golden.py` asserts. If the two ever disagree about one byte,
 * one of those suites fails — that is the whole mechanism.
 *
 * Consequence for this file: it must not drift from the Python model. `delta_bps` is an
 * integer in basis points rather than a float percentage precisely so the two languages
 * cannot disagree over number formatting.
 */

export interface Span {
  readonly span_id: string
  readonly parent_id: string | null
  readonly name: string
  readonly start_ns: number
  readonly dur_ns: number
}

export interface Trace {
  readonly trace_id: string
  readonly label: string
  readonly spans: readonly Span[]
}

export type TokenKind = 'ws' | 'lparen' | 'rparen' | 'sym' | 'string' | 'number'

export interface Token {
  readonly kind: TokenKind
  readonly text: string
  readonly start: number
  readonly end: number
}

export type HunkOp = 'equal' | 'insert' | 'delete'

export interface Hunk {
  readonly op: HunkOp
  readonly base_start: number
  readonly base_len: number
  readonly head_start: number
  readonly head_len: number
  readonly tokens: string[]
}

export interface ColumnDelta {
  readonly column: string
  readonly added: number
  readonly removed: number
  readonly changed: number
  readonly unchanged: number
}

export type ChangeStatus =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'depth_shifted'
  | 'duration_regressed'
  | 'duration_improved'
  | 'reordered'
  | 'duration_changed'
  | 'unchanged'

export interface Row {
  readonly span_id: string
  readonly name: string
  readonly depth: number
  readonly status: ChangeStatus
  readonly flags: ChangeStatus[]
  readonly base_dur_ns: number | null
  readonly head_dur_ns: number | null
  readonly delta_ns: number | null
  readonly delta_bps: number | null
  readonly base_depth: number | null
}

export interface Roundtrip {
  readonly base_verified: boolean
  readonly head_verified: boolean
  readonly lossless: boolean
}

export interface Stats {
  readonly total_rows: number
  readonly added: number
  readonly removed: number
  readonly renamed: number
  readonly depth_shifted: number
  readonly duration_regressed: number
  readonly duration_improved: number
  readonly reordered: number
  readonly unchanged: number
  readonly orphans: number
}

export interface TraceSummary {
  readonly trace_id: string
  readonly label: string
  readonly span_count: number
  readonly byte_length: number
  readonly token_count: number
  readonly significant_count: number
  readonly lossless: boolean
}

export interface Report {
  readonly base: TraceSummary
  readonly head: TraceSummary
  readonly stats: Stats
  readonly rows: readonly Row[]
  readonly column_deltas: readonly ColumnDelta[]
  readonly hunks: readonly Hunk[]
  readonly edit_cost: number
  readonly roundtrip: Roundtrip
}

/** The columnar storage layout. Must match `model.COLUMNS` in the reference engine. */
export const COLUMNS = ['span_id', 'parent_id', 'name', 'start_ns', 'dur_ns', 'depth'] as const

export type ColumnName = (typeof COLUMNS)[number]

export const FLDC_MAGIC = 'FLDC1'

/** Mirrors `protocol.EngineError`: a failure with a stable code the host can branch on. */
export class EngineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}
