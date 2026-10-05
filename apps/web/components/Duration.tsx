'use client'

import { useEffect, useRef, useState } from 'react'
import { formatNs } from '@/lib/format'

/**
 * A duration in nanoseconds that counts up from zero, once, on first paint.
 *
 * This is the product's motion signature, and it is deliberately restrained: it runs once,
 * never on re-render, and never in a loop. It is also the only component on the page that
 * needs a browser API, which is why it is the only one marked `'use client'` — the formatting
 * it shares with the server-rendered timeline lives in `lib/format.ts`, where both sides can
 * reach it.
 *
 * The final value is in the markup from the start, so the animation never hides a number a
 * reader needs and `prefers-reduced-motion` can skip it with no loss of meaning.
 */
export function Duration({ value, emphasis }: { readonly value: number; readonly emphasis?: 'strong' }) {
  const [shown, setShown] = useState(value)
  const frame = useRef<number | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    const duration = 520
    const start = performance.now()

    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration)
      // Ease-out cubic: fast first, then settling, so the final digits stay readable.
      const eased = 1 - (1 - progress) ** 3
      setShown(Math.round(value * eased))
      if (progress < 1) {
        frame.current = requestAnimationFrame(tick)
      } else {
        setShown(value)
      }
    }

    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [value])

  return (
    <span className="timeline__num" data-emphasis={emphasis} aria-label={formatNs(value)}>
      {formatNs(shown)}
    </span>
  )
}
