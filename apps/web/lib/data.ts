import { SAMPLE_IDS, SAMPLE_TRACES, type SampleId } from './generated-samples'
import { diffOp } from '@flamediff/tracekit'
import type { Report, Trace } from '@flamediff/tracekit'

/**
 * The web app's data layer.
 *
 * This is the flagship surface of an api-first product, so it reads through one typed module
 * and nothing else — no `fetch` inside a component, and no engine call that bypasses the
 * engine's own operation registry.
 *
 * It uses `tracekit`, the TypeScript port, because Vercel runs this in a Node function with
 * no Python runtime. That port is held to the Python reference by
 * `fixtures/golden/cases.json`, asserted by both test suites, so the report rendered here is
 * the report the CLI renders. `/api/health` reports which implementation answered.
 */

/** A recording in the shape the engine accepts. Both casings work; this is the documented one. */
export type TraceInput = Trace | Record<string, unknown>

export type LoadResult =
  | { readonly ok: true; readonly report: Report }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface SampleOption {
  readonly id: SampleId
  readonly label: string
  readonly spanCount: number
}

export function sampleOptions(): readonly SampleOption[] {
  return SAMPLE_IDS.map((id) => {
    const trace = SAMPLE_TRACES[id]
    return {
      id,
      label: `${trace.label} (${trace.spans.length} spans)`,
      spanCount: trace.spans.length,
    }
  })
}

export function loadSample(id: string | undefined): TraceInput | null {
  if (id === undefined || !SAMPLE_IDS.includes(id as SampleId)) return null
  return SAMPLE_TRACES[id as SampleId] as unknown as TraceInput
}

/**
 * Compare two recordings. Returns a discriminated result rather than throwing, so a page can
 * render the engine's own error code to the reader instead of a generic failure box.
 */
export function compare(base: unknown, head: unknown): LoadResult {
  try {
    return { ok: true, report: diffOp({ base, head }) }
  } catch (cause) {
    const code = (cause as { code?: string }).code ?? 'INTERNAL'
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, code, message }
  }
}

/** The comparison the landing page shows, so the first paint is already product data. */
export function defaultComparison(): LoadResult | null {
  const base = loadSample('before')
  const head = loadSample('after')
  if (base === null || head === null) return null
  return compare(base, head)
}
/**
 * Post a comparison to the public API.
 *
 * This lives in the data layer, not in the component, so that "components never perform I/O"
 * stays true for the whole tree. The browser form and the server-rendered page therefore reach
 * the engine by the same route a third-party caller would, and any change to the API's shape
 * breaks one function instead of a component.
 */
export async function postDiff(base: unknown, head: unknown): Promise<LoadResult> {
  try {
    const response = await fetch('/api/diff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base, head }),
    })
    const body = (await response.json()) as Record<string, unknown>
    if (!response.ok || body['ok'] !== true) {
      const error = body['error'] as { code?: string; message?: string } | undefined
      return {
        ok: false,
        code: error?.code ?? `HTTP ${response.status}`,
        message: error?.message ?? 'The comparison was refused.',
      }
    }
    return { ok: true, report: body['report'] as Report }
  } catch (cause) {
    return {
      ok: false,
      code: 'NETWORK',
      message: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** The outcome of parsing pasted JSON: either a recording, or a refusal with a code. */
export type ParseResult =
  | { readonly ok: true; readonly value: TraceInput }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Parse pasted JSON into a recording, refusing with the engine's own vocabulary. */
export function parsePasted(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return {
      ok: false,
      code: 'BAD_JSON',
      message: `That is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
  const record = parsed as Record<string, unknown>
  // The engine accepts both `trace_id` and `traceId`; this only checks it is plausibly a
  // recording, so the refusal names the mistake in the reader's own terms.
  const hasSpans = Array.isArray(record['spans'])
  const hasId = 'trace_id' in record || 'traceId' in record
  if (!hasSpans || !hasId) {
    return {
      ok: false,
      code: 'BAD_SHAPE',
      message: 'Expected a recording object with a "spans" array and either "trace_id" or "traceId".',
    }
  }
  return { ok: true, value: parsed as TraceInput }
}
