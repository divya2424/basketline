/**
 * Percentage of numerator over denominator, or null when it can't be computed
 * (missing count or zero denominator). Rates are always derived from counts.
 */
export function calculateRate(numerator, denominator) {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator <= 0) return null
  return (numerator / denominator) * 100
}

/** CTR = clicks / impressions × 100 */
export function calculateCtr(clicks, impressions) {
  return calculateRate(clicks, impressions)
}

/** Click-to-basket rate = clickToBasket / clicks × 100 */
export function calculateClickToBasketRate(clickToBasket, clicks) {
  return calculateRate(clickToBasket, clicks)
}
