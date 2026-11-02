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
