import type { Report } from '@flamediff/tracekit'
import { LATEST_VERSION } from './migrations.js'
import type { Store } from './store.js'

/**
 * The product's index over the columnar payloads.
 *
 * Recordings are stored COLUMNAR — one column per attribute, in the `FLDC` container — and this
 * table holds the container text plus the facts worth querying. Reports are stored as their
 * VERDICT only; the rows are recomputed from the two containers, because a persisted row list
 * would be a second thing that can disagree with the engine.
 *
 * That split is the storage decision recorded in `docs/adr/0003-columnar-payloads.md`: the
 * payload is columnar so "which attributes moved" is answerable, and the index is relational so
 * "which recordings do I have?" is answerable. Neither job is done badly.
 */

export interface RecordingRow {
  readonly trace_id: string
  readonly label: string
  readonly span_count: number
  readonly byte_length: number
  readonly token_count: number
  readonly container: string
  readonly recorded_at: number
}

export interface ReportRow {
  readonly id: string
  readonly base_trace_id: string
  readonly head_trace_id: string
  readonly edit_cost: number
  readonly lossless: number
  readonly added: number
  readonly removed: number
  readonly renamed: number
  readonly depth_shifted: number
  readonly regressed: number
  readonly improved: number
  readonly unchanged: number
  readonly stats_json: string
  readonly columns_json: string
  readonly created_at: number
}

export class TraceIndex {
  readonly #store: Store

  constructor(store: Store) {
    this.#store = store
  }

  get schemaVersion(): number {
    return this.#store.version
  }

  get latestSchemaVersion(): number {
    return LATEST_VERSION
  }

  get hasPendingMigrations(): boolean {
    return this.#store.isPending
  }

  /** Record one recording. Re-recording the same id at the same instant is a no-op update. */
  putRecording(recording: Omit<RecordingRow, 'recorded_at'> & { recorded_at?: number }): void {
    this.#store.transaction(() => {
      this.#store.run(
        `INSERT INTO recordings (trace_id, label, span_count, byte_length, token_count, container, recorded_at)
         VALUES (@trace_id, @label, @span_count, @byte_length, @token_count, @container, @recorded_at)
         ON CONFLICT(trace_id, recorded_at) DO UPDATE SET
           label = excluded.label,
           span_count = excluded.span_count,
           byte_length = excluded.byte_length,
           token_count = excluded.token_count,
           container = excluded.container`,
        {
          trace_id: recording.trace_id,
          label: recording.label,
          span_count: recording.span_count,
          byte_length: recording.byte_length,
          token_count: recording.token_count,
          container: recording.container,
          recorded_at: recording.recorded_at ?? 0,
        },
      )
    })
  }

  /** The most recent recording for a trace id, which is the one a comparison should use. */
  latestRecording(traceId: string): RecordingRow | undefined {
    return this.#store.rawOne<RecordingRow>(
      'SELECT * FROM recordings WHERE trace_id = ? ORDER BY recorded_at DESC LIMIT 1',
      [traceId],
    )
  }

  listRecordings(limit = 50): readonly RecordingRow[] {
    return this.#store.raw('SELECT * FROM recordings ORDER BY recorded_at DESC, trace_id ASC LIMIT ?', [
      limit,
    ]) as RecordingRow[]
  }

  countRecordings(): number {
    return (this.#store.rawOne<{ n: number }>('SELECT COUNT(*) AS n FROM recordings') ?? { n: 0 }).n
  }

  /** Store a report's verdict. The rows are deliberately not persisted. */
  putReport(id: string, report: Report, now: number): void {
    this.#store.transaction(() => {
      this.#store.run(
        `INSERT INTO reports (
           id, base_trace_id, head_trace_id, edit_cost, lossless,
           added, removed, renamed, depth_shifted, regressed, improved, unchanged,
           stats_json, columns_json, created_at
         ) VALUES (
           @id, @base_trace_id, @head_trace_id, @edit_cost, @lossless,
           @added, @removed, @renamed, @depth_shifted, @regressed, @improved, @unchanged,
           @stats_json, @columns_json, @created_at
         )
         ON CONFLICT(id) DO UPDATE SET
           edit_cost = excluded.edit_cost,
           lossless = excluded.lossless,
           stats_json = excluded.stats_json,
           columns_json = excluded.columns_json`,
        {
          id,
          base_trace_id: report.base.trace_id,
          head_trace_id: report.head.trace_id,
          edit_cost: report.edit_cost,
          lossless: report.roundtrip.lossless ? 1 : 0,
          added: report.stats.added,
          removed: report.stats.removed,
          renamed: report.stats.renamed,
          depth_shifted: report.stats.depth_shifted,
          regressed: report.stats.duration_regressed,
          improved: report.stats.duration_improved,
          unchanged: report.stats.unchanged,
          stats_json: JSON.stringify(report.stats),
          columns_json: JSON.stringify(report.column_deltas),
          created_at: now,
        },
      )
    })
  }

  getReport(id: string): ReportRow | undefined {
    return this.#store.rawOne<ReportRow>('SELECT * FROM reports WHERE id = ?', [id])
  }

  /** Reports between one pair of recordings, newest first. */
  listReports(baseTraceId: string, headTraceId: string, limit = 20): readonly ReportRow[] {
    return this.#store.raw(
      `SELECT * FROM reports WHERE base_trace_id = ? AND head_trace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [baseTraceId, headTraceId, limit],
    ) as ReportRow[]
  }

  /**
   * Every recorded comparison whose faithfulness verdict failed.
   *
   * This is the query that makes the guarantee actionable: a report that could not be proved
   * faithful is a report nobody should act on, so it must be findable.
   */
  listUnverifiedReports(limit = 20): readonly ReportRow[] {
    return this.#store.raw('SELECT * FROM reports WHERE lossless = 0 ORDER BY created_at DESC LIMIT ?', [
      limit,
    ]) as ReportRow[]
  }

  /** The recordings with the most regressions — the ones worth looking at. */
  worstPairs(limit = 10): readonly ReportRow[] {
    return this.#store.raw(
      `SELECT * FROM reports WHERE lossless = 1 AND regressed > 0
       ORDER BY regressed DESC, edit_cost DESC LIMIT ?`,
      [limit],
    ) as ReportRow[]
  }

  close(): void {
    this.#store.close()
  }
}
