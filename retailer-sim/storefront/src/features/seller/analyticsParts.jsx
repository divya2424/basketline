import { Fragment } from 'react'
import { Button } from '../../components/common/Button.jsx'

const number = new Intl.NumberFormat('en-IN')
export const formatNumber = (value) => number.format(value)
export const formatPercent = (ratio) => `${(ratio * 100).toFixed(1)}%`

export const PERIODS = [7, 30, 90]

/** The period, as a segmented control. */
export function PeriodSwitch({ days, onChange }) {
  return (
    <div className="period-switch" role="group" aria-label="Period">
      {PERIODS.map((n) => (
        <Button key={n} size="sm" variant={n === days ? 'primary' : 'ghost'} aria-pressed={n === days} onClick={() => onChange(n)}>
          {n} days
        </Button>
      ))}
    </div>
  )
}

/** One headline number. */
export function KpiCard({ label, value, note }) {
  return (
    <div className="kpi">
      <dt className="kpi__label">{label}</dt>
      <dd className="kpi__value">{value}</dd>
      {note ? <dd className="kpi__note">{note}</dd> : null}
    </div>
  )
}

/**
 * The ad funnel: each step's bar scaled to the first (impressions), labelled
 * with its count, and the rate from the step before it.
 */
export function FunnelBars({ steps }) {
  const top = steps[0]?.value ?? 0
  return (
    <ol className="funnel">
      {steps.map((step, index) => {
        const share = top > 0 ? step.value / top : 0
        return (
          <li key={step.label} className="funnel__step">
            <div className="funnel__head">
              <span className="funnel__label">{step.label}</span>
              <span className="funnel__value">{formatNumber(step.value)}</span>
            </div>
            <div className="funnel__track" role="img" aria-label={`${step.label}: ${formatNumber(step.value)}`}>
              <div className="funnel__bar" style={{ width: `${share * 100}%` }} />
            </div>
            {index > 0 ? <p className="funnel__rate">{step.rate}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}

/** How a count splits between groups (web and mobile, visitors and registered), as one 100% bar with every share labelled. parts: [{ key, name, value }]. */
export function SplitBar({ label, parts, note }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const describe = (name, value) => `${name} ${formatNumber(value)} (${formatPercent(total > 0 ? value / total : 0)})`
  return (
    <div className="split">
      <div className="split__head">
        <span className="split__label">{label}</span>
        <span className="split__counts">
          {parts.map((part) => (
            <Fragment key={part.key}>
              <span className={`split__key split__key--${part.key}`} aria-hidden="true" />
              {describe(part.name, part.value)}
            </Fragment>
          ))}
        </span>
      </div>
      <div className="split__track" role="img" aria-label={`${label}: ${parts.map((part) => describe(part.name.toLowerCase(), part.value)).join(', ')}`}>
        {parts.map((part) => (part.value > 0 ? <div key={part.key} className={`split__part split__part--${part.key}`} style={{ flexGrow: part.value }} /> : null))}
      </div>
      {note ? <p className="split__note">{note}</p> : null}
    </div>
  )
}
