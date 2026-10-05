'use client'

import { ErrorState } from '@/components/states'

/**
 * The route-level error boundary.
 *
 * It shows the message it was given and offers a retry, and it does NOT show a stack trace:
 * a trace on a public page is noise at best and a disclosure at worst.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Error</span>
        <h1>That comparison could not be completed</h1>
      </section>
      <ErrorState title="The engine refused the request" code="UNEXPECTED">
        {error.message || 'The engine reported a failure with no message.'}
      </ErrorState>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  )
}
