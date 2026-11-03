// Formatters are created once at module level; constructing Intl objects is costly.
const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

export function formatINR(amount) {
  return inrFormatter.format(amount)
}
