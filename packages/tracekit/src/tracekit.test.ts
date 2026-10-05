/**
 * The port's own tests: the invariants it must hold in TypeScript, independent of the
 * golden file.
 *
 * `golden.test.ts` proves the port agrees with the reference on fixed inputs. This file
 * proves the port's own invariants hold on inputs nobody chose — a port can pass every
 * golden case and still be wrong on a case the fixture never contained.
 */

import { describe, expect, it } from 'vitest'
import { canonicalize, compareKeys, depthsOf, order, paths, render } from './canonical.js'
import { classify } from './classify.js'
import { decode, encode } from './columns.js'
import { editCost, editOps, hunks } from './edit.js'
import { EngineError, type Span, type Trace } from './types.js'
import { detokenize, significant, tokenize } from './tokenizer.js'

const span = (over: Partial<Span> = {}): Span => ({
  span_id: 'a',
  parent_id: null,
  name: 'x',
  start_ns: 0,
  dur_ns: 1,
  ...over,
})

const trace = (spans: Span[], trace_id = 't', label = 'run'): Trace => ({
  trace_id,
  label,
  spans,
})

/** A deterministic PRNG, so a failure is reproducible from the seed printed in the name. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function randomSpans(count: number, random: () => number): Span[] {
  const ids = Array.from({ length: count }, (_, index) => `s${index}`)
  return ids.map((spanId) => ({
    span_id: spanId,
    // Parents drawn freely: dangling parents and cycles both occur on purpose.
    parent_id: random() < 0.25 ? null : (ids[Math.floor(random() * count)] ?? null),
    name: `f${Math.floor(random() * 4)}`,
    start_ns: Math.floor(random() * 100),
    dur_ns: Math.floor(random() * 1000),
  }))
}

describe('tokenizer: every input is tokenized losslessly or refused', () => {
  const alphabet = ['(', ')', 'span', 'trace', ' ', '\n', '\t', '"a"', '0', '-7', '@', '\\', '"']

  it('holds across generated text', () => {
    const random = rng(20_261_005)
    for (let trial = 0; trial < 3_000; trial += 1) {
      const length = Math.floor(random() * 12)
      let text = ''
      for (let index = 0; index < length; index += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)] as string
      }
      let tokens
      try {
        tokens = tokenize(text)
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError)
        expect(['UNTERMINATED_STRING', 'UNEXPECTED_CHARACTER']).toContain((error as EngineError).code)
        continue
      }
      expect(detokenize(tokens)).toBe(text)
    }
  })

  it('offsets always index the source', () => {
    const random = rng(7)
    for (let trial = 0; trial < 1_000; trial += 1) {
      const text = ['(', '"x y"', '42', 'span', ' '].join(' ').repeat(Math.floor(random() * 4))
      for (const token of tokenize(text)) {
        expect(text.slice(token.start, token.end)).toBe(token.text)
      }
    }
  })
})

describe('canonicalisation: order independent and idempotent', () => {
  it('reordering the input array cannot change the output', () => {
    const random = rng(99)
    for (let trial = 0; trial < 500; trial += 1) {
      const spans = randomSpans(1 + Math.floor(random() * 7), random)
      const forward = canonicalize(trace(spans))
      const backward = canonicalize(trace([...spans].reverse()))
      expect(backward).toBe(forward)
    }
  })

  it('the canonical form survives its own token stream', () => {
    const random = rng(31337)
    for (let trial = 0; trial < 500; trial += 1) {
      const spans = randomSpans(1 + Math.floor(random() * 7), random)
      const text = canonicalize(trace(spans))
      expect(detokenize(tokenize(text))).toBe(text)
    }
  })

  it('every span is rendered exactly once', () => {
    const random = rng(5150)
    for (let trial = 0; trial < 500; trial += 1) {
      const spans = randomSpans(1 + Math.floor(random() * 7), random)
      const { text } = render(trace(spans))
      const rendered = tokenize(text).filter((token) => token.kind === 'sym' && token.text === 'span').length
      expect(rendered).toBe(spans.length)
    }
  })

  it('a cycle terminates and is reported as detached', () => {
    const { text, detached } = render(
      trace([span({ span_id: 'a', parent_id: 'b' }), span({ span_id: 'b', parent_id: 'a' })]),
    )
    expect(detached).toBe(2)
    expect(tokenize(text).filter((token) => token.text === 'span').length).toBe(2)
  })

  it('a deep chain does not overflow the stack', () => {
    const spans: Span[] = [span({ span_id: 's0' })]
    for (let level = 1; level < 5_000; level += 1) {
      spans.push(span({ span_id: `s${level}`, parent_id: `s${level - 1}` }))
    }
    expect(depthsOf(spans).get('s4999')).toBe(4_999)
    expect(order(trace(spans))[0]).toBe('s0')
  })
})

describe('edit script: minimal against a brute-force oracle', () => {
  function lcsLength(a: string[], b: string[]): number {
    let previous = new Array<number>(b.length + 1).fill(0)
    for (let i = 1; i <= a.length; i += 1) {
      const current = new Array<number>(b.length + 1).fill(0)
      for (let j = 1; j <= b.length; j += 1) {
        current[j] =
          a[i - 1] === b[j - 1]
            ? (previous[j - 1] as number) + 1
            : Math.max(previous[j] as number, current[j - 1] as number)
      }
      previous = current
    }
    return previous[b.length] as number
  }

  it('cost equals n + m - 2*lcs for generated pairs', () => {
    const random = rng(1_337)
    const alphabet = ['a', 'b', 'c']
    for (let trial = 0; trial < 1_500; trial += 1) {
      const left = Array.from(
        { length: Math.floor(random() * 16) },
        () => alphabet[Math.floor(random() * alphabet.length)] as string,
      )
      const right = Array.from(
        { length: Math.floor(random() * 16) },
        () => alphabet[Math.floor(random() * alphabet.length)] as string,
      )
      expect(editCost(editOps(left, right))).toBe(left.length + right.length - 2 * lcsLength(left, right))
    }
  })

  it('the same pair always yields the same script', () => {
    const random = rng(77)
    for (let trial = 0; trial < 500; trial += 1) {
      const left = Array.from({ length: Math.floor(random() * 18) }, () => String(Math.floor(random() * 4)))
      const right = Array.from({ length: Math.floor(random() * 18) }, () => String(Math.floor(random() * 4)))
      expect(editOps(left, right)).toEqual(editOps(left, right))
    }
  })

  it('hunks partition both sequences exactly', () => {
    const random = rng(808)
    const alphabet = ['(', ')', 'a', 'b']
    for (let trial = 0; trial < 500; trial += 1) {
      const left = Array.from(
        { length: Math.floor(random() * 14) },
        () => alphabet[Math.floor(random() * alphabet.length)] as string,
      )
      const right = Array.from(
        { length: Math.floor(random() * 14) },
        () => alphabet[Math.floor(random() * alphabet.length)] as string,
      )
      const grouped = hunks(left, right, editOps(left, right))
      expect(grouped.reduce((total, hunk) => total + hunk.base_len, 0)).toBe(left.length)
      expect(grouped.reduce((total, hunk) => total + hunk.head_len, 0)).toBe(right.length)
    }
  })
})

describe('columnar container', () => {
  const sample: Span[] = [
    span({ span_id: 'root', name: 'http.handle', start_ns: 0, dur_ns: 12_000 }),
    span({ span_id: 'q', parent_id: 'root', name: 'db.query', start_ns: 100, dur_ns: 3_000 }),
    span({ span_id: 'c', parent_id: 'root', name: 'cache.get', start_ns: 400, dur_ns: 200 }),
  ]

  it('encoding is canonical, not input order', () => {
    expect(encode(trace([...sample].reverse()))).toBe(encode(trace(sample)))
  })

  it('encode/decode/encode is byte stable', () => {
    const text = encode(trace(sample))
    expect(encode(decode(text))).toBe(text)
  })

  it('the span set survives a round trip', () => {
    const recovered = decode(encode(trace(sample)))
    const key = (item: Span): string => item.span_id
    expect([...recovered.spans].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      [...sample].sort((a, b) => key(a).localeCompare(key(b))),
    )
  })

  it('a name containing a space survives', () => {
    const awkward = [span({ name: 'we "ird"\tname with spaces' })]
    expect(decode(encode(trace(awkward))).spans[0]?.name).toBe('we "ird"\tname with spaces')
  })

  it('non-ascii survives as ascii', () => {
    const text = encode(trace([span({ name: 'café' })]))
    expect(text).toContain('\\u00e9')
    expect(decode(text).spans[0]?.name).toBe('café')
  })

  it('refuses a container whose depth contradicts its tree', () => {
    const text = encode(trace(sample)).replace('depth u64 3\n0\t1\t1', 'depth u64 3\n5\t5\t5')
    expect(() => decode(text)).toThrowError(/depth/)
  })

  it('refuses a dangling parent', () => {
    const text = encode(trace(sample)).replace('""\t"root"\t"root"', '"ghost"\t"root"\t"root"')
    expect(() => decode(text)).toThrowError(/ghost/)
  })

  it('refuses trailing junk', () => {
    expect(() => decode(`${encode(trace(sample))}surprise\n`)).toThrowError(/unread line/)
  })
})

describe('classification', () => {
  const base: Span[] = [
    span({ span_id: 'r', name: 'handle', start_ns: 0, dur_ns: 1_000 }),
    span({ span_id: 'a', parent_id: 'r', name: 'cache', start_ns: 10, dur_ns: 100 }),
    span({ span_id: 'b', parent_id: 'r', name: 'db', start_ns: 20, dur_ns: 500 }),
  ]

  it('reports a rename as a rename, not a delete plus an add', () => {
    const head: Span[] = [
      base[0] as Span,
      span({ span_id: 'a', parent_id: 'r', name: 'cache.v2', start_ns: 10, dur_ns: 100 }),
      base[2] as Span,
    ]
    const { stats } = classify(trace(base), trace(head))
    expect(stats.renamed).toBe(1)
    expect(stats.added).toBe(0)
    expect(stats.removed).toBe(0)
  })

  it('a doubling past the threshold is a regression', () => {
    const head: Span[] = [
      base[0] as Span,
      span({ span_id: 'a', parent_id: 'r', name: 'cache', start_ns: 10, dur_ns: 300 }),
      base[2] as Span,
    ]
    expect(classify(trace(base), trace(head), 1.25).stats.duration_regressed).toBe(1)
  })

  it('a removal does not invent a reordering', () => {
    const head: Span[] = [base[0] as Span, base[2] as Span]
    expect(classify(trace(base), trace(head)).stats.reordered).toBe(0)
  })

  it('a reparenting is a depth shift', () => {
    const head: Span[] = [
      base[0] as Span,
      base[2] as Span,
      span({ span_id: 'a', parent_id: 'b', name: 'cache', start_ns: 10, dur_ns: 100 }),
    ]
    const { rows, stats } = classify(trace(base), trace(head))
    expect(stats.depth_shifted).toBe(1)
    const row = rows.find((candidate) => candidate.span_id === 'a')
    expect([row?.base_depth, row?.depth]).toEqual([1, 2])
  })

  it('an identical recording is entirely unchanged', () => {
    const { stats } = classify(trace(base), trace([...base].reverse()))
    expect(stats.unchanged).toBe(3)
  })

  it('a trivial jitter is suppressed by the minimum duration', () => {
    const head: Span[] = [
      base[0] as Span,
      span({ span_id: 'a', parent_id: 'r', name: 'cache', start_ns: 10, dur_ns: 101 }),
      base[2] as Span,
    ]
    expect(classify(trace(base), trace(head), 1.25, 1_000).stats.unchanged).toBe(3)
  })
})

describe('basis points round toward negative infinity', () => {
  // Python's // floors and JavaScript's Math.trunc does not. -600 on 6800 is exactly the
  // case the golden file caught: trunc gives -882, floor gives -883.
  const probe = (base: number, head: number): number | null => {
    const rows = classify(
      trace([span({ span_id: 'r', name: 'handle', start_ns: 0, dur_ns: base })]),
      trace([span({ span_id: 'r', name: 'handle', start_ns: 0, dur_ns: head })]),
    ).rows
    return rows[0]?.delta_bps ?? null
  }

  it('rounds a fractional regression down', () => {
    expect(probe(6_800, 7_400)).toBe(882)
  })

  it('rounds a fractional improvement down, not toward zero', () => {
    expect(probe(6_800, 6_200)).toBe(-883)
  })

  it('is exact when the division lands on a whole number', () => {
    expect(probe(1_000, 2_000)).toBe(10_000)
    expect(probe(1_000, 500)).toBe(-5_000)
  })

  it('reports no basis points when the baseline was zero', () => {
    expect(probe(0, 500)).toBeNull()
  })
})

describe('path keys and pre-order agree', () => {
  it('sorting by path key reproduces pre-order', () => {
    const random = rng(4_242)
    for (let trial = 0; trial < 300; trial += 1) {
      const spans = randomSpans(1 + Math.floor(random() * 7), random)
      const parsed = trace(spans)
      const byPath = [...paths(parsed).entries()].sort((a, b) => compareKeys(a[1], b[1])).map(([id]) => id)
      expect(byPath).toEqual(order(parsed))
    }
  })

  it('significant tokens drop whitespace only', () => {
    expect(significant(tokenize('( a\n b )')).map((token) => token.text)).toEqual(['(', 'a', 'b', ')'])
  })
})
