import Database from 'better-sqlite3'
import { MIGRATIONS, LATEST_VERSION, pendingMigrations } from './migrations.js'

export interface RecordRow {
  id: string
  kind: string
  payload: string
  created_at: number
  updated_at: number
}

/**
 * Every write goes through `transaction()`. No ad-hoc db.exec outside it — that rule is
 * what makes concurrent writers safe and makes a failed write leave no partial state.
 */
export class Store {
  readonly #db: Database.Database

  constructor(path = ':memory:') {
    this.#db = new Database(path)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('foreign_keys = ON')
    this.migrate()
  }

  get version(): number {
    return (this.#db.pragma('user_version', { simple: true }) as number) ?? 0
  }

  get isPending(): boolean {
    return pendingMigrations(this.version).length > 0
  }

  migrate(): number {
    const from = this.version
    for (const migration of pendingMigrations(from)) {
      this.transaction(() => {
        for (const statement of migration.up) this.#db.exec(statement)
        this.#db.pragma(`user_version = ${migration.version}`)
      })
    }
    return this.version
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)()
  }

  /**
   * Escape hatch for callers that own their own statement — the product's trace index, which
   * has its own tables.
   *
   * Bindings are always passed as parameters, never interpolated into the SQL.
   * `better-sqlite3` accepts either a positional array or a single named-parameter object, so
   * both shapes are supported and forwarded as-is. This exists so a second module can own a
   * schema without the store having to know about it; it is not an invitation to concatenate a
   * query string, and the only callers in this repository are `trace-index.ts`.
   */
  raw<T = unknown>(sql: string, parameters: readonly unknown[] | Record<string, unknown> = []): T[] {
    return this.#db.prepare(sql).all(parameters) as T[]
  }

  /** One row, or undefined. The single-row form of `raw`. */
  rawOne<T = unknown>(
    sql: string,
    parameters: readonly unknown[] | Record<string, unknown> = [],
  ): T | undefined {
    return this.#db.prepare(sql).get(parameters) as T | undefined
  }

  /**
   * The write counterpart to `raw`.
   *
   * `better-sqlite3` refuses `.all()` on a statement that returns no data, which is a
   * genuinely useful error: it means a caller cannot accidentally read rows from an INSERT.
   * `run` returns the SQLite change count, which is what `delete` needs.
   */
  run(sql: string, parameters: readonly unknown[] | Record<string, unknown> = []): number {
    return this.#db.prepare(sql).run(parameters).changes
  }

  put(record: { id: string; kind: string; payload: unknown; now: number }): void {
    const text = JSON.stringify(record.payload)
    this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO records (id, kind, payload, created_at, updated_at)
           VALUES (@id, @kind, @payload, @now, @now)
           ON CONFLICT(id) DO UPDATE SET
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
        )
        .run({ id: record.id, kind: record.kind, payload: text, now: record.now })

      // FTS5 virtual tables do not support UPSERT (ON CONFLICT), so the index row is
      // replaced explicitly. This is a SQLite limitation, not a style preference.
      this.#db.prepare('DELETE FROM records_fts WHERE id = ?').run(record.id)
      this.#db.prepare('INSERT INTO records_fts (id, body) VALUES (?, ?)').run(record.id, text)
    })
  }

  get(id: string): RecordRow | undefined {
    return this.#db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined
  }

  list(kind: string, limit = 50): readonly RecordRow[] {
    return this.#db
      .prepare('SELECT * FROM records WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
      .all(kind, limit) as RecordRow[]
  }

  search(query: string, limit = 50): readonly RecordRow[] {
    return this.#db
      .prepare(
        `SELECT r.* FROM records_fts f
           JOIN records r ON r.id = f.id
           WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as RecordRow[]
  }

  delete(id: string): boolean {
    return this.transaction(() => {
      const result = this.#db.prepare('DELETE FROM records WHERE id = ?').run(id)
      this.#db.prepare('DELETE FROM records_fts WHERE id = ?').run(id)
      return result.changes > 0
    })
  }

  close(): void {
    this.#db.close()
  }
}

export { LATEST_VERSION, MIGRATIONS }
