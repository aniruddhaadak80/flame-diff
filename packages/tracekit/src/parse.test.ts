import { describe, expect, it } from 'vitest'
import { parseTrace } from './api.js'
import { EngineError } from './types.js'

const snake = {
  trace_id: 't',
  label: 'run',
  spans: [{ span_id: 'a', parent_id: null, name: 'x', start_ns: 0, dur_ns: 5 }],
}

const camel = {
  traceId: 't',
  label: 'run',
  spans: [{ spanId: 'a', parentId: null, name: 'x', startNs: 0, durNs: 5 }],
}

describe('casing', () => {
  // Both casings are accepted, and they are the SAME trace. The engine's vocabulary is
  // snake_case because it mirrors the storage format, but callers arrive from JavaScript.
  // Normalising at the boundary means the HTTP API, the CLI and the MCP server cannot each
  // invent their own coercion — which is exactly how a TypeScript port and a Python
  // reference end up disagreeing about what a request means.
  it('parses camelCase to the same trace', () => {
    expect(parseTrace(camel)).toEqual(parseTrace(snake))
  })

  it('still accepts snake_case', () => {
    expect(parseTrace(snake).trace_id).toBe('t')
  })

  it('defaults a missing label to empty', () => {
    const withoutLabel: Record<string, unknown> = { ...snake }
    delete withoutLabel['label']
    expect(parseTrace(withoutLabel).label).toBe('')
  })

  it('prefers snake_case when both are present', () => {
    expect(parseTrace({ ...snake, traceId: 'ignored' }).trace_id).toBe('t')
  })

  it('honours an explicit null parent', () => {
    expect(parseTrace(snake).spans[0]?.parent_id).toBeNull()
  })
})

describe('rejection', () => {
  const cases: Array<[unknown, string]> = [
    [{ spans: [] }, 'BAD_SHAPE'],
    [{ trace_id: 't', spans: 'nope' }, 'BAD_SHAPE'],
    [{ trace_id: 7, spans: [] }, 'BAD_SHAPE'],
    [{ trace_id: 't', spans: [{}] }, 'BAD_SHAPE'],
    [{ trace_id: 't', label: 3, spans: [] }, 'BAD_SHAPE'],
    ['not an object', 'BAD_SHAPE'],
    [{ trace_id: 't', spans: [{ span_id: 'a', name: 'x', start_ns: -1, dur_ns: 0 }] }, 'NEGATIVE_VALUE'],
    [{ trace_id: 't', spans: [{ span_id: 'a', name: 'x', start_ns: 0, dur_ns: -1 }] }, 'NEGATIVE_VALUE'],
    [{ trace_id: 't', spans: [{ span_id: '', name: 'x', start_ns: 0, dur_ns: 0 }] }, 'BAD_SHAPE'],
  ]

  for (const [payload, code] of cases) {
    it(`refuses ${JSON.stringify(payload).slice(0, 48)} with ${code}`, () => {
      try {
        parseTrace(payload)
        throw new Error('expected a refusal')
      } catch (cause) {
        expect(cause).toBeInstanceOf(EngineError)
        expect((cause as EngineError).code).toBe(code)
      }
    })
  }

  it('does not accept a boolean as a duration', () => {
    expect(() =>
      parseTrace({
        trace_id: 't',
        spans: [{ span_id: 'a', name: 'x', start_ns: 0, dur_ns: true }],
      }),
    ).toThrowError(/dur_ns must be an integer/)
  })

  it('refuses duplicate span ids', () => {
    const span = { span_id: 'a', name: 'x', start_ns: 0, dur_ns: 1 }
    expect(() => parseTrace({ trace_id: 't', spans: [span, { ...span }] })).toThrowError(/appears twice/)
  })
})
