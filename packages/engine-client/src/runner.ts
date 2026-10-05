import { EngineBridge } from './bridge.js'
import { analyse as portAnalyse, type EngineError } from '@flamediff/tracekit'

/**
 * Which implementation answered a call. Reported in every tool result so a caller always
 * knows which engine produced an answer — a report that silently came from the port when the
 * reference was expected is exactly the kind of thing nobody notices until it matters.
 */
export type EngineFlavour = 'python' | 'typescript'

export interface RunnerOptions {
  /** Absolute or cwd-relative path to the monorepo root. */
  readonly root: string
  readonly python?: string
  readonly timeoutMs?: number
  /**
   * Fall back to the TypeScript port when the Python reference cannot be reached.
   *
   * This exists for deployment targets without a Python runtime — Vercel's Node functions
   * have none. It is not a licence for the two implementations to drift: `tracekit` is held
   * to the reference by `fixtures/golden/cases.json`, asserted by both test suites. Set it
   * to false where Python is guaranteed, and `doctor` will tell you which path is live.
   */
  readonly allowTypeScriptFallback?: boolean
}

export interface EngineResult<T = unknown> {
  readonly value: T
  readonly flavour: EngineFlavour
  /** Why the reference was not used, when it was not. Absent when it was. */
  readonly fallbackReason?: string
}

/**
 * Whether the Python reference answers right now. Powers `doctor` and `/api/health`.
 *
 * A discriminated union rather than an optional field, so a caller that has checked
 * `reachable` gets a `version` without a null check — and cannot forget to.
 */
export type EngineProbe =
  | { readonly reachable: true; readonly detail: string; readonly version: string }
  | { readonly reachable: false; readonly detail: string }

export class EngineRunner {
  readonly #bridge: EngineBridge | undefined
  readonly #allowFallback: boolean

  constructor(options: RunnerOptions) {
    const python = options.python ?? process.env['PRODUCT_PYTHON'] ?? 'python'
    const root = options.root
    this.#bridge = new EngineBridge({
      module: 'flame_diff',
      cwd: `${root}/services/engine/src`,
      python,
      timeoutMs: options.timeoutMs ?? 20_000,
    })
    this.#allowFallback = options.allowTypeScriptFallback ?? true
  }

  /**
   * Run one operation. Prefers the Python reference; falls back to the TypeScript port only
   * when configured to, and reports which one answered.
   */
  async call<T = unknown>(op: string, input: unknown): Promise<EngineResult<T>> {
    try {
      const value = (await this.#bridge?.call({ op, input })) as T
      return { value, flavour: 'python' }
    } catch (cause) {
      if (!this.#allowFallback) throw cause
      const value = portAnalyse(op, input) as T
      return { value, flavour: 'typescript', fallbackReason: describe(cause) }
    }
  }

  /** Whether the Python reference answers right now. Powers `doctor` and `/api/health`. */
  async probe(): Promise<EngineProbe> {
    try {
      const value = (await this.#bridge?.call({ op: 'health', input: {} })) as { version?: string }
      return {
        reachable: true,
        detail: 'python reference engine responded',
        version: value?.version ?? 'unknown',
      }
    } catch (cause) {
      return { reachable: false, detail: describe(cause) }
    }
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as EngineError).code
    return code === undefined ? cause.message : `${code}: ${cause.message}`
  }
  return String(cause)
}
