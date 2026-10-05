/**
 * The minimal edit script, mirrored from `services/engine/src/flame_diff/edit.py`.
 *
 * Myers' O(ND) difference algorithm in its linear-space form: the forward and reverse
 * D-paths are searched in lockstep until they overlap, and the split point is found
 * recursively. Memory stays O((N+M) log(N+M)) rather than the O(ND) trace an edit-graph
 * backtrack would need, which is what lets this run on real recordings.
 *
 * Two properties are load-bearing and are asserted in BOTH languages:
 *   * minimality — the non-equal step count equals N + M - 2*LCS, checked against a
 *     brute-force longest-common-subsequence oracle;
 *   * determinism — ties break toward the deletion branch, so the same pair always yields
 *     byte-identical output.
 *
 * The overlap test is the subtle part. The reverse pass is indexed by j = delta - k_reverse,
 * so the forward array must be read at `delta - j` to land on the SAME diagonal. Reading it
 * at `j` compiles, terminates, and returns a non-minimal script — which is why the oracle
 * test exists rather than a spot check.
 */

import type { Hunk, HunkOp, Token } from './types.js'

export type Step = readonly [HunkOp, number, number]

export const OP_EQUAL: HunkOp = 'equal'
export const OP_INSERT: HunkOp = 'insert'
export const OP_DELETE: HunkOp = 'delete'

const MAX_SPAN = 4_000_000

/** `a_index` is meaningful for equal/delete, `b_index` for equal/insert. The other is -1. */
export function editOps(a: readonly string[], b: readonly string[]): Step[] {
  if (a.length + b.length > MAX_SPAN) {
    throw new RangeError(`refusing to diff ${a.length}+${b.length} tokens`)
  }
  const steps: Step[] = []
  solve(a, b, 0, a.length, 0, b.length, steps)
  return steps
}

export function editCost(steps: readonly Step[]): number {
  let cost = 0
  for (const [op] of steps) if (op !== OP_EQUAL) cost += 1
  return cost
}

/** Group a flat edit script into runs of equal operation. */
export function hunks(a: readonly string[], b: readonly string[], steps: readonly Step[]): Hunk[] {
  const out: Array<{
    op: HunkOp
    base_start: number
    base_len: number
    head_start: number
    head_len: number
    tokens: string[]
  }> = []

  for (const [op, positionA, positionB] of steps) {
    const token = op === OP_EQUAL || op === OP_DELETE ? (a[positionA] as string) : (b[positionB] as string)
    const current = out[out.length - 1]
    if (current !== undefined && current.op === op && continues(current, op, positionA, positionB)) {
      if (op === OP_EQUAL) {
        current.base_len += 1
        current.head_len += 1
      } else if (op === OP_DELETE) {
        current.base_len += 1
      } else {
        current.head_len += 1
      }
      current.tokens.push(token)
      continue
    }

    if (op === OP_EQUAL) {
      out.push({
        op,
        base_start: positionA,
        base_len: 1,
        head_start: positionB,
        head_len: 1,
        tokens: [token],
      })
    } else if (op === OP_DELETE) {
      out.push({
        op,
        base_start: positionA,
        base_len: 1,
        head_start: -1,
        head_len: 0,
        tokens: [token],
      })
    } else {
      out.push({
        op,
        base_start: -1,
        base_len: 0,
        head_start: positionB,
        head_len: 1,
        tokens: [token],
      })
    }
  }

  return out
}

function continues(
  hunk: { base_start: number; base_len: number; head_start: number; head_len: number },
  op: HunkOp,
  positionA: number,
  positionB: number,
): boolean {
  if (op === OP_EQUAL || op === OP_DELETE) return hunk.base_start + hunk.base_len === positionA
  return hunk.head_start + hunk.head_len === positionB
}

export function editScript(a: readonly Token[], b: readonly Token[]): Hunk[] {
  const left = a.map((token) => token.text)
  const right = b.map((token) => token.text)
  return hunks(left, right, editOps(left, right))
}

/** The minimal edit script between two SIGNIFICANT token sequences, as runs. */
export function diffTokens(a: readonly string[], b: readonly string[]): Hunk[] {
  return hunks(a, b, editOps(a, b))
}

function solve(
  a: readonly string[],
  b: readonly string[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  out: Step[],
): void {
  const left = a.slice(x0, x1)
  const right = b.slice(y0, y1)

  // Trim the common prefix: it is always in an optimal script.
  let offset = 0
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) {
    out.push([OP_EQUAL, x0 + offset, y0 + offset])
    offset += 1
  }

  // Trim the common suffix: ditto, but it must be emitted after the middle.
  let suffix = 0
  while (
    suffix < left.length - offset &&
    suffix < right.length - offset &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const ax0 = x0 + offset
  const ax1 = x1 - suffix
  const by0 = y0 + offset
  const by1 = y1 - suffix

  if (ax0 === ax1 && by0 === by1) {
    // Fully consumed by the trimmed prefix and suffix.
  } else if (ax0 === ax1) {
    for (let index = by0; index < by1; index += 1) out.push([OP_INSERT, -1, index])
  } else if (by0 === by1) {
    for (let index = ax0; index < ax1; index += 1) out.push([OP_DELETE, index, -1])
  } else {
    const [middleA, middleB] = middleSnake(a, b, ax0, ax1, by0, by1)
    solve(a, b, ax0, middleA, by0, middleB, out)
    solve(a, b, middleA, ax1, middleB, by1, out)
  }

  for (let index = 0; index < suffix; index += 1) {
    out.push([OP_EQUAL, ax1 + index, by1 + index])
  }
}

/** Find a point on an optimal path through (x0,y0)-(x1,y1). Returns that point. */
function middleSnake(
  a: readonly string[],
  b: readonly string[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): [number, number] {
  const n = x1 - x0
  const m = y1 - y0
  const delta = n - m
  const odd = delta % 2 !== 0
  const pad = n + m + 2
  const size = 2 * (n + m) + 5
  const forward = new Array<number>(size).fill(0)
  const reverse = new Array<number>(size).fill(0)
  forward[pad + 1] = 0
  reverse[pad + 1] = 0

  for (let d = 0; d <= n + m; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      // Deletion first on ties: this is the determinism guarantee.
      let x: number
      if (k === -d || (k !== d && (forward[pad + k - 1] as number) < (forward[pad + k + 1] as number))) {
        x = forward[pad + k + 1] as number
      } else {
        x = (forward[pad + k - 1] as number) + 1
      }
      let y = x - k
      if (y < 0 || y > m) continue
      while (x < n && y < m && a[x0 + x] === b[y0 + y]) {
        x += 1
        y += 1
      }
      forward[pad + k] = x
      if (odd && delta - k >= -(d - 1) && delta - k <= d - 1) {
        if (x + (reverse[pad + delta - k] as number) >= n) return [x0 + x, y0 + y]
      }
    }

    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (reverse[pad + k - 1] as number) < (reverse[pad + k + 1] as number))) {
        x = reverse[pad + k + 1] as number
      } else {
        x = (reverse[pad + k - 1] as number) + 1
      }
      let y = x - k
      if (y < 0 || y > m) continue
      while (x < n && y < m && a[x0 + n - 1 - x] === b[y0 + m - 1 - y]) {
        x += 1
        y += 1
      }
      reverse[pad + k] = x
      if (!odd && delta - k >= -d && delta - k <= d) {
        // The forward point must sit on the SAME diagonal as this reverse point. The reverse
        // pass is indexed by j = delta - k_reverse, so that diagonal is delta - k here.
        if ((forward[pad + delta - k] as number) + x >= n) return [x0 + n - x, y0 + m - y]
      }
    }
  }

  return [x1, y1]
}
