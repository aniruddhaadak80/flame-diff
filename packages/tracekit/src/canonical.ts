/**
 * The canonical rendering, mirrored from `services/engine/src/flame_diff/canonical.py`.
 *
 * A trace is a forest of spans, written as a nested s-expression in pre-order with every
 * node's siblings sorted by (name, start_ns, span_id). Two properties follow and both are
 * asserted by tests in both languages: order independence and idempotence.
 *
 * `build` is the single ordering authority in the package — the renderer, the columnar
 * codec and the classifier all read pre-order from `walk`, so they cannot drift.
 */

import { escape } from './escape.js'
import type { Span, Trace } from './types.js'

export const INDENT = '  '

/**
 * The sibling sort key. Also one step of an ancestry path, which is why paths sort like
 * pre-order.
 *
 * `start_ns` leads deliberately. A flame graph is read as time moving downward, so children
 * must come out in the order they ran. Name is the tiebreaker so two spans starting at the
 * same instant still order deterministically, and `span_id` breaks any remaining tie.
 *
 * Ordering by name instead would be stable under rename but would render the stack backwards
 * relative to how it executed, which is the one thing a flame graph must not do.
 */
export type SortKey = readonly [number, string, string]

function sortKey(span: Span): SortKey {
  return [span.start_ns, span.name, span.span_id]
}

function compareKeys(a: readonly SortKey[], b: readonly SortKey[]): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index] as SortKey
    const right = b[index] as SortKey
    if (left[0] !== right[0]) return left[0] - right[0]
    if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1
    if (left[2] !== right[2]) return left[2] < right[2] ? -1 : 1
  }
  return a.length - b.length
}

interface Node {
  readonly span: Span
  readonly depth: number
  readonly children: Node[]
}

/**
 * Root nodes plus a detached count.
 *
 * A span is detached when its parent is absent from the recording, or when it sits on a
 * cycle. Detached spans are still rendered — as leaves, so they stay visible in the report
 * — but they are counted, because a recording that lost its tree is a fact the caller needs
 * rather than something to smooth over.
 */
export function build(trace: Trace): { roots: Node[]; detached: number } {
  const spans = trace.spans
  const byId = new Map(spans.map((span) => [span.span_id, span]))

  let detached = 0
  const childrenOf = new Map<string, Span[]>()
  for (const span of spans) {
    const parent = span.parent_id
    if (parent === null || !byId.has(parent)) {
      if (parent !== null) detached += 1
      continue
    }
    const bucket = childrenOf.get(parent)
    if (bucket === undefined) childrenOf.set(parent, [span])
    else bucket.push(span)
  }
  for (const bucket of childrenOf.values()) bucket.sort(compareSpans)

  const roots: Node[] = []
  const visited = new Set<string>()

  const rootSpans = spans
    .filter((span) => span.parent_id === null || !byId.has(span.parent_id))
    .sort(compareSpans)

  // Explicitly a stack, not recursion: a recording 10k spans deep must not exhaust the
  // call stack, and the same has to hold in the Python reference.
  for (const rootSpan of rootSpans) {
    if (visited.has(rootSpan.span_id)) continue
    const siblings: Node[] = []
    const stack: Array<{ span: Span; target: Node[]; depth: number }> = [
      { span: rootSpan, target: siblings, depth: 0 },
    ]
    while (stack.length > 0) {
      const frame = stack.pop() as { span: Span; target: Node[]; depth: number }
      if (visited.has(frame.span.span_id)) continue
      const node: Node = { span: frame.span, depth: frame.depth, children: [] }
      visited.add(frame.span.span_id)
      frame.target.push(node)
      const kids = childrenOf.get(frame.span.span_id) ?? []
      for (let offset = kids.length - 1; offset >= 0; offset -= 1) {
        stack.push({ span: kids[offset] as Span, target: node.children, depth: frame.depth + 1 })
      }
    }
    roots.push(...siblings)
  }

  // Anything unvisited is on a cycle. Render it as a leaf and count it.
  //
  // Merged back into the root list and re-sorted, NOT appended: a detached span is a root
  // like any other, and leaving it at the end would make path-key order disagree with
  // pre-order for exactly the tangled recordings where ordering is hardest to reason about.
  const tangled = spans.filter((span) => !visited.has(span.span_id)).sort(compareSpans)
  for (const span of tangled) {
    detached += 1
    roots.push({ span, depth: 0, children: [] })
  }
  roots.sort((a, b) => compareSpans(a.span, b.span))

  return { roots, detached }
}

function compareSpans(a: Span, b: Span): number {
  return compareKeys([sortKey(a)], [sortKey(b)])
}

/** Every span as a node, in canonical pre-order, plus the detached count. */
export function walk(trace: Trace): { nodes: Node[]; detached: number } {
  const { roots, detached } = build(trace)
  const ordered: Node[] = []
  for (const root of roots) {
    const stack: Node[] = [root]
    while (stack.length > 0) {
      const node = stack.pop() as Node
      ordered.push(node)
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index] as Node)
      }
    }
  }
  return { nodes: ordered, detached }
}

export function order(trace: Trace): string[] {
  return walk(trace).nodes.map((node) => node.span.span_id)
}

export function depthsOf(spans: readonly Span[]): Map<string, number> {
  const depths = new Map<string, number>()
  for (const node of walk({ trace_id: '', label: '', spans }).nodes) {
    depths.set(node.span.span_id, node.depth)
  }
  return depths
}

/**
 * Ancestry path per span id, as a sequence of sort keys from the root down.
 *
 * Sorting spans by path key yields exactly pre-order, which is what lets the classifier
 * merge two recordings with an ordinary sorted merge and still place removals in position.
 */
export function paths(trace: Trace): Map<string, SortKey[]> {
  const result = new Map<string, SortKey[]>()
  for (const root of build(trace).roots) {
    const stack: Array<{ node: Node; prefix: SortKey[] }> = [{ node: root, prefix: [] }]
    while (stack.length > 0) {
      const frame = stack.pop() as { node: Node; prefix: SortKey[] }
      const key = [...frame.prefix, sortKey(frame.node.span)]
      result.set(frame.node.span.span_id, key)
      for (const child of frame.node.children) stack.push({ node: child, prefix: key })
    }
  }
  return result
}

export function render(trace: Trace): { text: string; detached: number } {
  const { roots, detached } = build(trace)
  const lines: string[] = [`(trace ${escape(trace.trace_id)} ${escape(trace.label)} ${trace.spans.length})`]
  let emitted = 0

  const emit = (node: Node): void => {
    emitted += 1
    const span = node.span
    lines.push(
      `${INDENT.repeat(node.depth)}(span ${escape(span.span_id)} ${escape(span.name)} ` +
        `${span.start_ns} ${span.dur_ns}`,
    )
    for (const child of node.children) emit(child)
    lines.push(`${INDENT.repeat(node.depth)})`)
  }

  for (const root of roots) emit(root)
  lines.push(')')

  if (emitted !== trace.spans.length) {
    // A total function by construction; reaching here means the tree walk lost a span.
    throw new Error(`canonical render emitted ${emitted} of ${trace.spans.length} spans`)
  }
  return { text: lines.join('\n'), detached }
}

export function canonicalize(trace: Trace): string {
  return render(trace).text
}

export { compareKeys }
