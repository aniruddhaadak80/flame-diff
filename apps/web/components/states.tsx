/**
 * Loading, empty and error. Three genuinely different designs.
 *
 * They are not one component with a `kind` prop because they are not the same thing. Loading
 * is "not here yet, and you can see it is coming". Empty is "here, and there is nothing in
 * it — here is how to put something in it". Error is "something refused, and here is what it
 * said". Reusing one box for all three teaches a reader to distrust the one they are looking
 * at.
 */

export function LoadingState({ label }: { readonly label: string }) {
  return (
    <div className="panel" aria-busy="true" aria-live="polite">
      <p className="field__hint">{label}</p>
      <div className="stack" aria-hidden="true">
        {[72, 54, 88, 40, 63].map((width) => (
          <span className="skeleton" key={width} style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="state" data-kind="empty">
      <p>
        <strong>{title}</strong>
      </p>
      <div className="field__hint">{children}</div>
    </div>
  )
}

export function ErrorState({
  title,
  code,
  children,
}: {
  readonly title: string
  readonly code?: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="state" data-kind="error" role="alert">
      <p>
        <strong>{title}</strong>
        {code === undefined ? null : (
          <>
            {' '}
            <code className="inline-code">{code}</code>
          </>
        )}
      </p>
      <div className="field__hint">{children}</div>
    </div>
  )
}
