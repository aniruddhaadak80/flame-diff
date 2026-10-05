/**
 * Cross-language parity. This is the gate that makes the TypeScript port trustworthy.
 *
 * It asserts the SAME `fixtures/golden/cases.json` that `services/engine/tests/test_golden.py`
 * asserts. `services/engine` is the reference implementation; this port exists only because
 * Vercel has no Python runtime. If the two implementations ever disagree about a single
 * byte, exactly one of these two suites goes red — which is the entire point of keeping the
 * port at all.
 *
 * Regenerate the fixtures with `python services/engine/tools/gen_golden.py`. A change to
 * those files is a change to the product's observable behaviour, not a formatting fix, and
 * belongs in a commit that says so.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyse, canonicalize, decode, encode, significant, tokenize } from './api.js'
import type { Span, Trace } from './types.js'

interface GoldenCase {
  readonly name: string
  readonly input: { readonly base: unknown; readonly head: unknown }
  readonly expected: {
    readonly canonical: { readonly base: string; readonly head: string }
    readonly tokens: { readonly base: unknown[]; readonly head: unknown[] }
    readonly significantCount: { readonly base: number; readonly head: number }
    readonly report: unknown
    readonly container: { readonly base: string; readonly head: string }
    readonly decoded: { readonly base: unknown }
  }
}

interface GoldenFile {
  readonly version: number
  readonly cases: GoldenCase[]
}

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(
  readFileSync(join(here, '..', '..', '..', 'fixtures', 'golden', 'cases.json'), 'utf8'),
) as GoldenFile

expect(golden.version).toBe(1)
expect(golden.cases.length).toBeGreaterThanOrEqual(3)

describe('cross-language parity with the Python reference engine', () => {
  for (const testCase of golden.cases) {
    describe(testCase.name, () => {
      const base = testCase.input.base as Trace
      const head = testCase.input.head as Trace

      it('renders the same canonical text', () => {
        expect(canonicalize(base)).toBe(testCase.expected.canonical.base)
        expect(canonicalize(head)).toBe(testCase.expected.canonical.head)
      })

      it('produces the same token stream, offsets included', () => {
        expect(tokenize(testCase.expected.canonical.base)).toEqual(testCase.expected.tokens.base)
        expect(tokenize(testCase.expected.canonical.head)).toEqual(testCase.expected.tokens.head)
      })

      it('agrees on how many tokens carry meaning', () => {
        expect(significant(tokenize(testCase.expected.canonical.base)).length).toBe(
          testCase.expected.significantCount.base,
        )
        expect(significant(tokenize(testCase.expected.canonical.head)).length).toBe(
          testCase.expected.significantCount.head,
        )
      })

      it('produces an identical report', () => {
        expect(analyse('diff', testCase.input)).toEqual(testCase.expected.report)
      })

      it('writes a byte-identical columnar container', () => {
        expect(encode(base)).toBe(testCase.expected.container.base)
        expect(encode(head)).toBe(testCase.expected.container.head)
      })

      it('reads back what the reference wrote', () => {
        expect(decode(testCase.expected.container.base)).toEqual(testCase.expected.decoded.base)
      })
    })
  }

  it('the fixture is not trivially empty', () => {
    // A parity suite that asserts nothing is worse than none: it is a false green.
    const stats = golden.cases.map(
      (testCase) => (testCase.expected.report as { stats: Record<string, number> }).stats,
    )
    expect(stats.some((entry) => entry['duration_regressed']! > 0)).toBe(true)
    expect(stats.some((entry) => entry['added']! > 0)).toBe(true)
    expect(stats.some((entry) => entry['removed']! > 0)).toBe(true)
    expect(stats.some((entry) => entry['renamed']! > 0)).toBe(true)
  })

  it('every golden report is a verified lossless round trip', () => {
    for (const testCase of golden.cases) {
      const roundtrip = (testCase.expected.report as { roundtrip: { lossless: boolean } }).roundtrip
      expect(roundtrip.lossless).toBe(true)
    }
  })
})

describe('the port refuses exactly what the reference refuses', () => {
  const span = (over: Partial<Span> = {}): Span => ({
    span_id: 'a',
    parent_id: null,
    name: 'x',
    start_ns: 0,
    dur_ns: 1,
    ...over,
  })

  it('rejects a malformed trace', () => {
    expect(() => analyse('diff', { base: { trace_id: 't', spans: 'nope' } })).toThrowError(
      /spans must be an array/,
    )
  })

  it('rejects a duplicate span id', () => {
    expect(() =>
      analyse('canonicalize', {
        trace: { trace_id: 't', spans: [span(), span()] },
      }),
    ).toThrowError(/appears twice/)
  })

  it('rejects a negative duration', () => {
    expect(() =>
      analyse('canonicalize', {
        trace: { trace_id: 't', spans: [span({ dur_ns: -1 })] },
      }),
    ).toThrowError(/must not be negative/)
  })

  it('rejects an unknown operation by name', () => {
    expect(() => analyse('summarize', {})).toThrowError(/unknown op/)
  })

  it('rejects text outside the grammar', () => {
    expect(() => analyse('tokenize', { text: 'a@b' })).toThrowError(/unexpected character/)
    expect(() => analyse('tokenize', { text: '"unclosed' })).toThrowError(/unterminated string/)
  })
})
