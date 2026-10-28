import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { formatCount } from '../../utils/format.js'

/** Count card for one API metric, with loading, error and retry states. */
export function MetricCard({ label, description, state, onRetry }) {
  return (
    <article className={`metric-card metric-card--${state.status}`} aria-busy={state.status === 'loading'}>
      <h3 className="metric-card__label">{label}</h3>
      {state.status === 'loading' ? (
        <p className="metric-card__value metric-card__value--loading">
          <Spinner label={`Loading ${label}`} />
        </p>
      ) : state.status === 'error' ? (
        <div className="metric-card__error" role="alert">
          <p className="metric-card__value metric-card__value--muted">Unavailable</p>
          <p className="small">{state.error}</p>
          <Button variant="secondary" size="sm" onClick={onRetry} aria-label={`Retry ${label}`}>
            Retry
          </Button>
        </div>
      ) : (
        <p className="metric-card__value" data-testid={`metric-${label}`}>
          {formatCount(state.value)}
        </p>
      )}
      {description ? <p className="metric-card__description">{description}</p> : null}
    </article>
  )
}

/** Derived percentage card. `value` is null when it can't be computed. */
export function RateCard({ label, formula, value, loading }) {
  return (
    <article className="metric-card metric-card--rate" aria-busy={loading}>
      <h3 className="metric-card__label">{label}</h3>
      <p className="metric-card__value" data-testid={`rate-${label}`}>
        {loading ? <Spinner label={`Calculating ${label}`} /> : value}
      </p>
      <p className="metric-card__description">{formula}</p>
    </article>
  )
}
