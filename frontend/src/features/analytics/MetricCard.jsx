import { Button } from '../../components/common/Button.jsx'
import { formatCount, formatPercent } from '../../utils/format.js'

/**
 * Count card for one API metric: a label with a short hint, the headline number,
 * and below it whatever the metric adds (children: customers, split bars, …),
 * with loading (skeleton), error and retry states.
 */
export function MetricCard({ label, hint, state, onRetry, children, tone = 'default' }) {
  return (
    <article className={`metric-card metric-card--${tone} metric-card--${state.status}`} aria-busy={state.status === 'loading'}>
      <header className="metric-card__head">
        <h3 className="metric-card__label">{label}</h3>
        {hint ? <p className="metric-card__hint">{hint}</p> : null}
      </header>
      {state.status === 'loading' ? (
        <div role="status" className="metric-card__skeleton">
          <span className="skeleton skeleton--value" aria-hidden="true" />
          <span className="skeleton skeleton--line" aria-hidden="true" />
          <span className="skeleton skeleton--bar" aria-hidden="true" />
          <span className="visually-hidden">Loading {label}</span>
        </div>
      ) : state.status === 'error' ? (
        <div className="metric-card__error" role="alert">
          <p className="metric-card__error-title">Couldn’t load</p>
          <p className="small muted">{state.error}</p>
          <Button variant="secondary" size="sm" onClick={onRetry} aria-label={`Retry ${label}`}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <p className="metric-card__value" data-testid={`metric-${label}`}>
            {formatCount(state.value)}
          </p>
          <div className="metric-card__body">{children}</div>
        </>
      )}
    </article>
  )
}

/**
 * The conversion between two funnel steps (e.g. clicks ÷ impressions), shown on
 * the arrow between their cards. `value` is null when it can't be computed.
 */
export function FunnelRate({ label, short, formula, value, loading }) {
  return (
    <article className="funnel-rate" aria-busy={loading}>
      <span className="funnel-rate__arrow" aria-hidden="true" />
      <div className="funnel-rate__pill" title={formula}>
        <p className="funnel-rate__value" data-testid={`rate-${label}`}>
          {loading ? <span className="skeleton skeleton--pill" aria-hidden="true" /> : formatPercent(value)}
          {loading ? <span className="visually-hidden">Calculating {label}</span> : null}
        </p>
        <h3 className="funnel-rate__label">
          <span aria-hidden="true">{short}</span>
          <span className="visually-hidden">{label}</span>
        </h3>
      </div>
    </article>
  )
}

/** "1,240 customers", the people behind an event count. */
export function Customers({ value }) {
  return value == null ? null : (
    <p className="metric-card__customers">
      <strong>{formatCount(value)}</strong> {value === 1 ? 'customer' : 'customers'}
    </p>
  )
}

/**
 * A labelled share bar with its values: segments are { label, value, tone }.
 * Shares are of the segments' sum; the values are always printed, so the bar is
 * only a visual aid (aria-hidden).
 */
export function SplitBar({ title, segments }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  return (
    <div className="split">
      <p className="split__title">{title}</p>
      <div className="split__bar" aria-hidden="true">
        {total > 0
          ? segments.map((segment) =>
              segment.value > 0 ? (
                <span key={segment.label} className={`split__segment split__segment--${segment.tone}`} style={{ flexGrow: segment.value }} />
              ) : null,
            )
          : null}
      </div>
      <ul className="split__legend">
        {segments.map((segment) => (
          <li key={segment.label}>
            <span className={`split__dot split__segment--${segment.tone}`} aria-hidden="true" />
            {segment.label} <strong>{formatCount(segment.value)}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A share as a thin progress bar, e.g. converted sessions of all sessions. */
export function ProgressStat({ label, value, of }) {
  const share = of > 0 ? (value / of) * 100 : null
  return (
    <div className="progress-stat">
      <p className="progress-stat__text">
        {label} <strong>{formatCount(value)}</strong>
        <span className="muted"> · {formatPercent(share)}</span>
      </p>
      <div className="progress-stat__track" aria-hidden="true">
        <span className="progress-stat__fill" style={{ width: `${Math.min(share ?? 0, 100)}%` }} />
      </div>
    </div>
  )
}
