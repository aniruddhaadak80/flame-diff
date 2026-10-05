/**
 * A closed error taxonomy. Every error carries a stable `code` so that a CLI exit code,
 * an MCP error envelope, and an HTTP status can all be derived from one value.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UPSTREAM_FAILED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'

export class ProductError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ProductError'
    this.code = code
    this.details = details
  }
}

export class ValidationError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, details)
    this.name = 'ValidationError'
  }
}

export class PermissionError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PERMISSION_DENIED', message, details)
    this.name = 'PermissionError'
  }
}

export class NotFoundError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('NOT_FOUND', message, details)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONFLICT', message, details)
    this.name = 'ConflictError'
  }
}

export class TimeoutError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('TIMEOUT', message, details)
    this.name = 'TimeoutError'
  }
}

export class UpstreamError extends ProductError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('UPSTREAM_FAILED', message, details)
    this.name = 'UpstreamError'
  }
}

/** Narrowing helper for use across package boundaries. */
export function isProductError(value: unknown): value is ProductError {
  return value instanceof ProductError
}

/**
 * The most specific code available for a failure, for use in an error envelope.
 *
 * A tool that calls the engine raises `UpstreamError` with `UPSTREAM_FAILED`, because that is
 * the taxonomy code. But the engine refused for a reason — `UNEXPECTED_CHARACTER`,
 * `DUPLICATE_SPAN_ID`, `DEPTH_MISMATCH` — and a caller who only sees `UPSTREAM_FAILED` has to
 * guess. This prefers the upstream code when one is present, so the actionable string survives
 * the trip from the engine through the bridge to the CLI, the MCP envelope and the HTTP body.
 */
export function errorCodeOf(value: unknown): string {
  if (isProductError(value)) {
    const upstream = value.details?.['code']
    if (typeof upstream === 'string' && upstream !== '') return upstream
    return value.code
  }
  if (value instanceof Error) {
    const code = (value as unknown as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'INTERNAL'
}
