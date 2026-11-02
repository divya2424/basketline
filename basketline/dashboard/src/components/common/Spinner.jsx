/**
 * Circular loading indicator. Pass `label` for a spinner that stands alone (it
 * is announced to screen readers); omit it when visible text already says
 * what is loading.
 */
export function Spinner({ size = 'md', label, className = '' }) {
  const spinner = <span className={`spinner spinner--${size} ${className}`} aria-hidden="true" />
  if (!label) return spinner
  return (
    <span role="status" className="spinner-wrap">
      {spinner}
      <span className="visually-hidden">{label}</span>
    </span>
  )
}
