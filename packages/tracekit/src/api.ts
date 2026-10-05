/**
 * The operation registry — the engine's entire public surface, mirroring
 * `services/engine/src/flame_diff/api.py`.
 *
 * The operations are the same on both sides of the language boundary, and they take the same
 * argument names, so a caller cannot accidentally depend on one implementation's
 * conveniences. `services/engine` remains the reference; this module exists because Vercel
 * has no Python runtime.
 */

import { canonicalize, render } from './canonical.js'
import { classify } from './classify.js'
import { columnDeltas, decode, encode } from './columns.js'
import { editCost, editOps, hunks } from './edit.js'
import { detokenize, significant, tokenize, verifyRoundtrip } from './tokenizer.js'
import {
  EngineError,
  type ColumnDelta,
  type Report,
  type Span,
  type Token,
  type Trace,
  type TraceSummary,
} from './types.js'

export const VERSION = '0.1.0'

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Read a field that may arrive in either casing.
 *
 * The engine's own vocabulary is snake_case, because it mirrors the storage format. Callers
 * arrive with JavaScript-shaped camelCase, and normalising that at the boundary — once, here
 * — beats every surface inventing its own coercion. The Python reference does exactly the
 * same thing, which is what lets a `traceId` payload behave identically through the HTTP API,
 * the CLI and the MCP server.
 */
function field(raw: Record<string, unknown>, snake: string, camel: string): unknown {
  if (snake in raw) return raw[snake]
  if (camel in raw) return raw[camel]
  return undefined
}

/** Validate an untrusted trace, or throw with a stable code. Mirrors `model.parse_trace`. */
export function parseTrace(value: unknown, traceField = 'trace'): Trace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EngineError('BAD_SHAPE', `${traceField} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const rawTraceId = field(raw, 'trace_id', 'traceId')
  if (typeof rawTraceId !== 'string') {
    throw new EngineError('BAD_SHAPE', `${traceField}.trace_id must be a string`)
  }
  const rawLabel = field(raw, 'label', 'label') ?? ''
  if (typeof rawLabel !== 'string') {
    throw new EngineError('BAD_SHAPE', `${traceField}.label must be a string`)
  }
  const rawSpans = field(raw, 'spans', 'spans')
  if (!Array.isArray(rawSpans)) {
    throw new EngineError('BAD_SHAPE', `${traceField}.spans must be an array`)
  }

  const spans: Span[] = []
  const seen = new Set<string>()
  rawSpans.forEach((entry: unknown, index: number) => {
    const where = `${traceField}.spans[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new EngineError('BAD_SHAPE', `${where} must be an object`)
    }
    const span = entry as Record<string, unknown>
    const spanId = field(span, 'span_id', 'spanId')
    if (typeof spanId !== 'string') {
      throw new EngineError('BAD_SHAPE', `${where}.span_id must be a string`)
    }
    if (spanId === '') {
      throw new EngineError('BAD_SHAPE', `${where}.span_id must not be empty`)
    }
    if (seen.has(spanId)) {
      throw new EngineError('DUPLICATE_SPAN_ID', `${where}.span_id '${spanId}' appears twice`)
    }
    seen.add(spanId)

    const rawParent = field(span, 'parent_id', 'parentId')
    if (rawParent !== null && rawParent !== undefined && typeof rawParent !== 'string') {
      throw new EngineError('BAD_SHAPE', `${where}.parent_id must be a string or null`)
    }
    const name = field(span, 'name', 'name')
    if (typeof name !== 'string') {
      throw new EngineError('BAD_SHAPE', `${where}.name must be a string`)
    }
    const startNs = field(span, 'start_ns', 'startNs')
    // bool is not a number here: a duration of `true` is a bug, not a duration.
    if (typeof startNs !== 'number' || !Number.isInteger(startNs)) {
      throw new EngineError('BAD_SHAPE', `${where}.start_ns must be an integer`)
    }
    const durNs = field(span, 'dur_ns', 'durNs')
    if (typeof durNs !== 'number' || !Number.isInteger(durNs)) {
      throw new EngineError('BAD_SHAPE', `${where}.dur_ns must be an integer`)
    }
    if (startNs < 0) {
      throw new EngineError('NEGATIVE_VALUE', `${where}.start_ns must not be negative`)
    }
    if (durNs < 0) {
      throw new EngineError('NEGATIVE_VALUE', `${where}.dur_ns must not be negative`)
    }

    spans.push({
      span_id: spanId,
      parent_id: (rawParent ?? null) as string | null,
      name,
      start_ns: startNs,
      dur_ns: durNs,
    })
  })

  return { trace_id: rawTraceId, label: rawLabel, spans }
}

function requireField(payload: unknown, field: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new EngineError('BAD_SHAPE', 'input must be an object')
  }
  if (!(field in payload)) {
    throw new EngineError('MISSING_FIELD', `input is missing '${field}'`)
  }
  return (payload as Record<string, unknown>)[field]
}

function traceField(payload: unknown, field: string): Trace {
  return parseTrace(requireField(payload, field), field)
}

function integer(payload: unknown, field: string, fallback: number): number {
  if (typeof payload !== 'object' || payload === null || !(field in payload)) return fallback
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EngineError('BAD_SHAPE', `'${field}' must be an integer`)
  }
  if (value < 0) {
    throw new EngineError('BAD_SHAPE', `'${field}' must not be negative`)
  }
  return value
}

function ratio(payload: unknown, field: string, fallback: number): number {
  if (typeof payload !== 'object' || payload === null || !(field in payload)) return fallback
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'number') {
    throw new EngineError('BAD_SHAPE', `'${field}' must be a number`)
  }
  if (value < 1.0) {
    throw new EngineError('BAD_SHAPE', `'${field}' must be at least 1.0`)
  }
  return value
}

function summary(trace: Trace, text: string, significantCount: number): TraceSummary {
  const probe = verifyRoundtrip(text)
  return {
    trace_id: trace.trace_id,
    label: trace.label,
    span_count: trace.spans.length,
    byte_length: byteLength(text),
    token_count: probe.token_count,
    significant_count: significantCount,
    lossless: probe.lossless,
  }
}

export interface CanonicalizeResult {
  readonly text: string
  readonly byte_length: number
  readonly span_count: number
  readonly detached: number
  readonly lossless: boolean
  readonly token_count: number
  readonly significant_count: number
}

export function canonicalizeOp(payload: unknown): CanonicalizeResult {
  const trace = traceField(payload, 'trace')
  const { text, detached } = render(trace)
  const probe = verifyRoundtrip(text)
  return {
    text,
    byte_length: byteLength(text),
    span_count: trace.spans.length,
    detached,
    lossless: probe.lossless,
    token_count: probe.token_count,
    significant_count: probe.significant_count,
  }
}

export interface TokenizeResult {
  readonly tokens: Token[]
  readonly lossless: boolean
  readonly token_count: number
  readonly significant_count: number
  readonly byte_length: number
}

export function tokenizeOp(payload: unknown): TokenizeResult {
  const text = requireField(payload, 'text')
  if (typeof text !== 'string') {
    throw new EngineError('BAD_SHAPE', "'text' must be a string")
  }
  const probe = verifyRoundtrip(text)
  if (!probe.lossless) {
    throw new EngineError('ROUNDTRIP_FAILED', 'tokenizer did not reproduce its input')
  }
  return {
    tokens: tokenize(text),
    lossless: probe.lossless,
    token_count: probe.token_count,
    significant_count: probe.significant_count,
    byte_length: probe.byte_length,
  }
}

export function detokenizeOp(payload: unknown): { readonly text: string } {
  const raw = requireField(payload, 'tokens')
  if (!Array.isArray(raw)) {
    throw new EngineError('BAD_SHAPE', "'tokens' must be an array")
  }
  const texts: string[] = []
  raw.forEach((token: unknown, index: number) => {
    if (typeof token === 'string') {
      texts.push(token)
      return
    }
    if (typeof token === 'object' && token !== null && typeof (token as Token).text === 'string') {
      texts.push((token as Token).text)
      return
    }
    throw new EngineError('BAD_SHAPE', `tokens[${index}].text must be a string`)
  })
  return { text: texts.join('') }
}

function significantTexts(payload: unknown, field: string): string[] {
  const value = requireField(payload, field)
  if (typeof value === 'string') return significant(tokenize(value)).map((token) => token.text)
  if (!Array.isArray(value)) {
    throw new EngineError('BAD_SHAPE', `'${field}' must be a string or an array of tokens`)
  }
  return value.map((entry: unknown, index: number) => {
    if (typeof entry === 'string') return entry
    if (typeof entry === 'object' && entry !== null && typeof (entry as Token).text === 'string') {
      return (entry as Token).text
    }
    throw new EngineError('BAD_SHAPE', `'${field}'[${index}] must be a token`)
  })
}

export interface EditResult {
  readonly hunks: ReturnType<typeof hunks>
  readonly cost: number
  readonly base_tokens: number
  readonly head_tokens: number
}

export function editOp(payload: unknown): EditResult {
  const left = significantTexts(payload, 'base')
  const right = significantTexts(payload, 'head')
  const steps = editOps(left, right)
  return {
    hunks: hunks(left, right, steps),
    cost: editCost(steps),
    base_tokens: left.length,
    head_tokens: right.length,
  }
}

export interface DiffInput {
  readonly base: unknown
  readonly head: unknown
  readonly regression_ratio?: number
  readonly min_duration_ns?: number
  readonly max_hunks?: number
}

export function diffOp(payload: unknown): Report {
  const base = traceField(payload, 'base')
  const head = traceField(payload, 'head')
  const regressionRatio = ratio(payload, 'regression_ratio', 1.25)
  const minDuration = integer(payload, 'min_duration_ns', 0)
  const maxHunks = integer(payload, 'max_hunks', 5_000)

  const baseRender = render(base)
  const headRender = render(head)
  const baseTokens = significant(tokenize(baseRender.text))
  const headTokens = significant(tokenize(headRender.text))

  const left = baseTokens.map((token) => token.text)
  const right = headTokens.map((token) => token.text)
  const steps = editOps(left, right)
  let script = hunks(left, right, steps)
  if (script.length > maxHunks) script = script.slice(0, maxHunks)

  const { rows, stats } = classify(base, head, regressionRatio, minDuration)
  const statsWithOrphans = { ...stats, orphans: baseRender.detached + headRender.detached }

  const baseProbe = verifyRoundtrip(baseRender.text)
  const headProbe = verifyRoundtrip(headRender.text)

  const deltas: ColumnDelta[] = columnDeltas(base, head)

  return {
    base: summary(base, baseRender.text, baseTokens.length),
    head: summary(head, headRender.text, headTokens.length),
    stats: statsWithOrphans,
    rows,
    column_deltas: deltas,
    hunks: script,
    edit_cost: editCost(steps),
    roundtrip: {
      base_verified: baseProbe.lossless,
      head_verified: headProbe.lossless,
      lossless: baseProbe.lossless && headProbe.lossless,
    },
  }
}

export function columnsOp(payload: unknown): { readonly columns: ColumnDelta[] } {
  return { columns: columnDeltas(traceField(payload, 'base'), traceField(payload, 'head')) }
}

export function encodeOp(payload: unknown): { readonly text: string; readonly byte_length: number } {
  const text = encode(traceField(payload, 'trace'))
  return { text, byte_length: byteLength(text) }
}

export function decodeOp(payload: unknown): { readonly trace: Trace } {
  const text = requireField(payload, 'text')
  if (typeof text !== 'string') {
    throw new EngineError('BAD_SHAPE', "'text' must be a string")
  }
  return { trace: decode(text) }
}

export interface HealthResult {
  readonly ok: boolean
  readonly engine: string
  readonly version: string
  readonly pure: boolean
  readonly implementation: 'typescript'
  readonly operations: string[]
}

export function healthOp(): HealthResult {
  return {
    ok: true,
    engine: 'flame_diff',
    version: VERSION,
    pure: true,
    implementation: 'typescript',
    operations: Object.keys(OPERATIONS).sort(),
  }
}

/**
 * The registry. Keys are the operation names, and they are identical to the Python
 * `OPERATIONS` keys so a caller cannot tell the two implementations apart by name.
 */
export const OPERATIONS = {
  canonicalize: canonicalizeOp,
  columns: columnsOp,
  decode: decodeOp,
  detokenize: detokenizeOp,
  diff: diffOp,
  edit: editOp,
  encode: encodeOp,
  health: healthOp,
  tokenize: tokenizeOp,
} as const

export type OperationName = keyof typeof OPERATIONS

/**
 * Invoke an operation by name. The one entry point a transport needs, so there is exactly
 * one place where an operation name becomes a function.
 */
export function analyse(op: string, payload: unknown): unknown {
  const handler = (OPERATIONS as Record<string, ((input: unknown) => unknown) | undefined>)[op]
  if (handler === undefined) {
    const known = Object.keys(OPERATIONS).sort().join(', ')
    throw new EngineError('UNKNOWN_OP', `unknown op '${op}'; available: ${known}`)
  }
  return handler(payload)
}

export { canonicalize, detokenize, significant, tokenize, verifyRoundtrip }
export { classify, statsOf } from './classify.js'
export { columnDeltas, decode, encode, SEPARATOR } from './columns.js'
export { diffTokens, editCost, editOps, editScript, hunks } from './edit.js'
export { canonicalize as canonical, depthsOf, order, paths, walk } from './canonical.js'
export type { Token as EngineToken }
