/**
 * Duration and percentage formatting, shared by the server-rendered timeline and the
 * client-side counter that animates.
 *
 * These are plain functions with no browser APIs, so they belong in a module that is neither
 * server nor client. Putting them in a `'use client'` file makes them uncallable from the
 * server; putting them in a server component makes them uncallable from the client. One
 * shared module is the only arrangement where both can use the same formatting — and two
 * copies of "how do I render 0.4ms" is precisely the drift this product exists to avoid.
 */

export function formatNs(value: number): string {
  const magnitude = Math.abs(value)
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}ms`
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(2)}us`
  return `${Math.round(value)}ns`
}

export function signedNs(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatNs(Math.abs(value))}`
}

/** Basis points to a percentage. Integer basis points never reach this point as a float. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`
}

export function formatSignedBps(bps: number): string {
  return `${bps > 0 ? '+' : ''}${formatBps(bps)}`
}
