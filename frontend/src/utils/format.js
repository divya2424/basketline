// Formatters are created once at module level; constructing Intl objects is costly.
const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

const countFormatter = new Intl.NumberFormat('en-IN')

export function formatINR(amount) {
  return inrFormatter.format(amount)
}

export function formatCount(value) {
  return countFormatter.format(value)
}

export const EMPTY_VALUE = '—'

export function formatPercent(value) {
  return value === null ? EMPTY_VALUE : `${value.toFixed(2)}%`
}

/** A duration for people: "45 s", "12 min", "1 h 5 min". */
export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}
