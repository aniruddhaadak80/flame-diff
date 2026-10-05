import type { Metadata } from 'next'
import { SURFACES } from '@/lib/product'

export const metadata: Metadata = { title: 'Surfaces' }

const TONE = { shipped: 'ok', omitted: 'warn' } as const

/**
 * What ships, and what deliberately does not.
 *
 * The omissions are listed with their reasons on the same page as the shipped surfaces, not
 * in a footnote. A reviewer looking for a missing capability should be able to find the
 * decision that explains it, in one place.
 */
export default function SurfacesPage() {
  const shipped = SURFACES.filter((surface) => surface.status === 'shipped')
  const omitted = SURFACES.filter((surface) => surface.status === 'omitted')

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Capability</span>
        <h1>Surfaces</h1>
        <p>
          Every capability in this product is a Tool in one registry, reachable identically from each surface
          below. The CLI, the JSON API and the MCP server are three thin shells over one handler — not three
          implementations.
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__title">Shipped ({shipped.length})</h2>
        <div className="grid">
          {shipped.map((surface) => (
            <article className="card" key={surface.id}>
              <span className="badge" data-tone={TONE[surface.status]}>
                {surface.status}
              </span>
              <h3>{surface.title}</h3>
              <p>{surface.summary}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">Deliberately omitted ({omitted.length})</h2>
        <p className="field__hint">
          Each of these would have been strictly smaller than the core, or would have contradicted the
          product&apos;s central claim. Shipping four surfaces properly beats shipping eleven superficially.
        </p>
        <div className="grid">
          {omitted.map((surface) => (
            <article className="card" key={surface.id}>
              <span className="badge" data-tone={TONE[surface.status]}>
                {surface.status}
              </span>
              <h3>{surface.title}</h3>
              <p>{surface.summary}</p>
              {surface.reason !== undefined ? (
                <p className="field__hint">
                  <strong>why:</strong> {surface.reason}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
