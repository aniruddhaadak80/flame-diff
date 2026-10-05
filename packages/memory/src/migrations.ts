/**
 * Migrations are numbered, ordered, and idempotent. Never edit an applied migration —
 * append a new one. `user_version` is the source of truth for the applied prefix.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: [
      `CREATE TABLE IF NOT EXISTS records (
         id         TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS records_kind_idx ON records (kind, updated_at DESC)`,
    ],
  },
  {
    version: 2,
    name: 'full_text',
    up: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
         id UNINDEXED, body, tokenize = 'porter unicode61'
       )`,
    ],
  },
  {
    version: 3,
    name: 'recordings_and_reports',
    up: [
      // The payload of a recording is COLUMNAR — one column per attribute, stored as the FLDC
      // container. SQLite holds the index and the container text, never a per-span row. This is
      // the storage decision from docs/adr/0003-columnar-payloads.md: a row per span would make
      // "which columns moved" a scan-and-compare instead of a question the layout can answer.
      `CREATE TABLE IF NOT EXISTS recordings (
         trace_id     TEXT NOT NULL,
         label        TEXT NOT NULL,
         span_count   INTEGER NOT NULL,
         byte_length  INTEGER NOT NULL,
         token_count  INTEGER NOT NULL,
         container    TEXT NOT NULL,
         recorded_at  INTEGER NOT NULL,
         PRIMARY KEY (trace_id, recorded_at)
       )`,
      `CREATE INDEX IF NOT EXISTS recordings_recent_idx ON recordings (recorded_at DESC)`,
      // A report references two recordings and keeps only its VERDICT. The rows themselves are
      // recomputed from the containers, because a stored row list would be a second thing to
      // keep in sync with the engine.
      `CREATE TABLE IF NOT EXISTS reports (
         id               TEXT PRIMARY KEY,
         base_trace_id    TEXT NOT NULL,
         head_trace_id    TEXT NOT NULL,
         edit_cost        INTEGER NOT NULL,
         lossless         INTEGER NOT NULL,
         added            INTEGER NOT NULL,
         removed          INTEGER NOT NULL,
         renamed          INTEGER NOT NULL,
         depth_shifted    INTEGER NOT NULL,
         regressed        INTEGER NOT NULL,
         improved         INTEGER NOT NULL,
         unchanged        INTEGER NOT NULL,
         stats_json       TEXT NOT NULL,
         columns_json     TEXT NOT NULL,
         created_at       INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS reports_recent_idx ON reports (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS reports_pair_idx ON reports (base_trace_id, head_trace_id)`,
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export function pendingMigrations(current: number): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
