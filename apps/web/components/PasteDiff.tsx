'use client'

import { useState } from 'react'
import type { Report } from '@flamediff/tracekit'
import { parsePasted, postDiff } from '@/lib/data'
import { SAMPLE_TRACES } from '@/lib/generated-samples'
import { ReportView } from './ReportView'
import { ErrorState } from './states'

/**
 * The paste-your-own path, client side.
 *
 * It posts to `/api/diff` — the same JSON API the CLI and MCP surfaces speak — and renders
 * with the same `ReportView` the server path uses. There is one implementation of "show a
 * report", so the server-rendered and client-rendered results cannot drift apart visually.
 *
 * The server-rendered path (`/compare`) remains the no-JavaScript path; this is the path for
 * a recording that does not exist on the server yet.
 */

interface State {
  readonly kind: 'idle' | 'loading' | 'done' | 'error'
  readonly code?: string
  readonly message?: string
  readonly report?: Report
}

export function PasteDiff() {
  const [base, setBase] = useState('')
  const [head, setHead] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const parsedBase = parsePasted(base)
    if (!parsedBase.ok) {
      setState({ kind: 'error', code: `before - ${parsedBase.code}`, message: parsedBase.message })
      return
    }
    const parsedHead = parsePasted(head)
    if (!parsedHead.ok) {
      setState({ kind: 'error', code: `after - ${parsedHead.code}`, message: parsedHead.message })
      return
    }

    setState({ kind: 'loading' })
    const result = await postDiff(parsedBase.value, parsedHead.value)
    if (!result.ok) {
      setState({ kind: 'error', code: result.code, message: result.message })
      return
    }
    setState({ kind: 'done', report: result.report })
  }

  return (
    <div className="stack">
      <form className="compare-form" onSubmit={submit}>
        <div className="compare-form__row">
          <div className="field">
            <label htmlFor="paste-base">Before</label>
            <textarea
              id="paste-base"
              name="base"
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder='{"trace_id":"run-a","label":"before","spans":[...]}'
              spellCheck={false}
            />
            <span className="field__hint">
              A recording object with a <code className="inline-code">spans</code> array.
            </span>
          </div>
          <div className="field">
            <label htmlFor="paste-head">After</label>
            <textarea
              id="paste-head"
              name="head"
              value={head}
              onChange={(event) => setHead(event.target.value)}
              placeholder='{"trace_id":"run-a","label":"after","spans":[...]}'
              spellCheck={false}
            />
            <span className="field__hint">Span ids are matched, so keep them stable.</span>
          </div>
        </div>

        <div className="compare-form__row">
          <button className="button" type="submit" disabled={state.kind === 'loading'}>
            {state.kind === 'loading' ? 'Comparing…' : 'Compare'}
          </button>
          <button
            className="button"
            type="button"
            data-variant="quiet"
            onClick={() => {
              setBase(JSON.stringify(SAMPLE_TRACES.before, null, 2))
              setHead(JSON.stringify(SAMPLE_TRACES.after, null, 2))
            }}
          >
            Fill with the sample pair
          </button>
        </div>
      </form>

      {state.kind === 'error' ? (
        <ErrorState title="That comparison was refused" code={state.code}>
          {state.message}
        </ErrorState>
      ) : null}

      {state.kind === 'done' && state.report !== undefined ? <ReportView report={state.report} /> : null}
    </div>
  )
}
