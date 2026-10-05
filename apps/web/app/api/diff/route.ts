import { NextResponse } from 'next/server'
import { compare, sampleOptions } from '@/lib/data'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `POST /api/diff` — the flagship JSON API.
 *
 * This is the same computation the CLI and the MCP server perform, over the same registry, so
 * a caller does not get a different answer depending on which door it came through. That is
 * the whole point of the narrow waist.
 *
 * Errors come back with the engine's own stable code and a human message. A client can branch
 * on `BAD_SHAPE` without parsing prose.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024

export async function POST(request: Request): Promise<NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'INPUT_TOO_LARGE', message: `body exceeds ${MAX_BODY_BYTES} bytes` },
      },
      { status: 413 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch (cause) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'BAD_JSON',
          message: `request body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      },
      { status: 400 },
    )
  }

  const payload = body as Record<string, unknown>
  const result = compare(payload?.['base'], payload?.['head'])

  if (!result.ok) {
    const status = result.code === 'MISSING_FIELD' ? 400 : 422
    return NextResponse.json({ ok: false, error: { code: result.code, message: result.message } }, { status })
  }

  return NextResponse.json({ ok: true, report: result.report }, { headers: { 'cache-control': 'no-store' } })
}

/** `GET /api/diff` documents itself, because an API you have to guess at is not an API. */
export function GET(): NextResponse {
  return NextResponse.json({
    ok: true,
    service: 'flame-diff',
    method: 'POST /api/diff',
    request: {
      base: '{ "trace_id": string, "label": string, "spans": [...] }',
      head: '{ "trace_id": string, "label": string, "spans": [...] }',
      span: {
        span_id: 'string, unique within the recording, stable across both recordings',
        parent_id: 'string | null',
        name: 'string',
        start_ns: 'integer >= 0',
        dur_ns: 'integer >= 0',
      },
    },
    returns: 'the report: stats, rows, column_deltas, hunks, edit_cost, roundtrip',
    samples: sampleOptions(),
  })
}
