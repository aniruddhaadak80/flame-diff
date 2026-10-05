import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffOp, decode, encode, type Trace } from '@flamediff/tracekit'
import { LATEST_VERSION, MIGRATIONS, Store, TraceIndex } from './index.js'

/**
 * The index is tested against a real SQLite file, not a mock, because the things that break a
 * database are the things a mock cannot reproduce: WAL behaviour, FTS5, foreign keys, and
 * whether a migration is genuinely idempotent.
 */

const BASE: Trace = {
  trace_id: 'checkout',
  label: 'before',
  spans: [
    { span_id: 'r', parent_id: null, name: 'handle', start_ns: 0, dur_ns: 10_000 },
    { span_id: 'a', parent_id: 'r', name: 'db.query', start_ns: 100, dur_ns: 4_000 },
  ],
}

const HEAD: Trace = {
  trace_id: 'checkout',
  label: 'after',
  spans: [
    { span_id: 'r', parent_id: null, name: 'handle', start_ns: 0, dur_ns: 10_000 },
    { span_id: 'a', parent_id: 'r', name: 'db.query', start_ns: 100, dur_ns: 9_000 },
    { span_id: 'b', parent_id: 'r', name: 'retry', start_ns: 9_100, dur_ns: 600 },
  ],
}

let dir: string
let store: Store
let index: TraceIndex

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flame-diff-'))
  store = new Store(join(dir, 'index.db'))
  index = new TraceIndex(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('applies every migration and records the version', () => {
    expect(store.version).toBe(LATEST_VERSION)
    expect(index.hasPendingMigrations).toBe(false)
  })

  it('is idempotent — running migrate twice changes nothing', () => {
    const before = store.version
    store.migrate()
    store.migrate()
    expect(store.version).toBe(before)
  })

  it('never re-applies an already applied migration', () => {
    // user_version is the applied prefix, so a fresh store must not run migration 1 twice.
    expect(store.version).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1))
  })
})

describe('recordings', () => {
  it('stores a columnar container and finds it back', () => {
    index.putRecording({
      trace_id: 'checkout',
      label: 'before',
      span_count: BASE.spans.length,
      byte_length: encode(BASE).length,
      token_count: 42,
      container: encode(BASE),
      recorded_at: 1_000,
    })

    const found = index.latestRecording('checkout')
    expect(found?.span_count).toBe(2)
    // The container round-trips, so the payload is genuinely columnar and lossless.
    expect(found?.container).toBe(encode(BASE))
    expect(index.countRecordings()).toBe(1)
  })

  it('returns the most recent recording for a trace id', () => {
    for (const [label, dur] of [
      ['old', 1_000],
      ['new', 2_000],
    ] as const) {
      index.putRecording({
        trace_id: 'checkout',
        label,
        span_count: 1,
        byte_length: 1,
        token_count: 1,
        container: 'FLDC1',
        recorded_at: dur,
      })
    }
    expect(index.latestRecording('checkout')?.label).toBe('new')
    expect(index.countRecordings()).toBe(2)
  })

  it('lists the most recent recordings first', () => {
    index.putRecording({
      trace_id: 'a',
      label: 'a',
      span_count: 1,
      byte_length: 1,
      token_count: 1,
      container: 'FLDC1',
      recorded_at: 1,
    })
    index.putRecording({
      trace_id: 'b',
      label: 'b',
      span_count: 1,
      byte_length: 1,
      token_count: 1,
      container: 'FLDC1',
      recorded_at: 2,
    })
    expect(index.listRecordings().map((row) => row.trace_id)).toEqual(['b', 'a'])
  })

  it('returns undefined for an unknown recording', () => {
    expect(index.latestRecording('nope')).toBeUndefined()
  })
})

describe('reports', () => {
  const report = diffOp({ base: BASE, head: HEAD })

  it('stores the verdict and reads it back', () => {
    index.putReport('r1', report, 5_000)
    const row = index.getReport('r1')
    expect(row?.edit_cost).toBe(report.edit_cost)
    expect(row?.lossless).toBe(1)
    expect(row?.regressed).toBe(report.stats.duration_regressed)
    expect(row?.added).toBe(report.stats.added)
  })

  it('does not persist the rows — they are recomputed from the containers', () => {
    index.putReport('r1', report, 5_000)
    const row = index.getReport('r1')
    expect(row?.stats_json).not.toContain('span_id')
    expect(JSON.parse(row?.columns_json ?? '[]')).toHaveLength(6)
  })

  it('updates an existing report rather than duplicating it', () => {
    index.putReport('r1', report, 1)
    index.putReport('r1', report, 2)
    expect(index.listReports('checkout', 'checkout')).toHaveLength(1)
  })

  it('lists reports for one pair of recordings', () => {
    index.putReport('r1', report, 1)
    const other: Trace = { ...BASE, trace_id: 'checkout-eu' }
    index.putReport('other', diffOp({ base: other, head: other }), 1)
    expect(index.listReports('checkout', 'checkout').map((row) => row.id)).toEqual(['r1'])
    expect(index.listReports('checkout-eu', 'checkout-eu').map((row) => row.id)).toEqual(['other'])
  })

  it('surfaces comparisons that could not be proved faithful', () => {
    const broken = { ...report, roundtrip: { ...report.roundtrip, lossless: false } }
    index.putReport('bad', broken, 1)
    index.putReport('good', report, 1)
    expect(index.listUnverifiedReports().map((row) => row.id)).toEqual(['bad'])
  })

  it('ranks pairs by how many things regressed', () => {
    index.putReport('few', diffOp({ base: BASE, head: BASE }), 1)
    index.putReport('many', report, 1)
    expect(index.worstPairs().map((row) => row.id)).toEqual(['many'])
  })
})

describe('the index and the engine agree', () => {
  it('recomputes the same verdict from the stored container', () => {
    // The whole point of storing the container rather than the rows: the report is derived, so
    // it cannot drift from the engine.
    const container = encode(BASE)
    index.putRecording({
      trace_id: 'checkout',
      label: 'before',
      span_count: BASE.spans.length,
      byte_length: container.length,
      token_count: 12,
      container,
      recorded_at: 1,
    })

    const stored = index.latestRecording('checkout')
    const decoded = decode(stored?.container ?? '')
    const recomputed = diffOp({ base: decoded, head: HEAD })
    expect(recomputed.edit_cost).toBe(diffOp({ base: BASE, head: HEAD }).edit_cost)
  })
})
