/**
 * Time ranges for the dashboard. Days are UTC days, matching the backend's
 * daily aggregates: "Last 7 days" is today plus the 6 UTC days before it.
 *
 * A range is either { preset: '30d' } or { custom: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } },
 * with both custom dates included.
 */
const DAY = 24 * 60 * 60 * 1000
export const MAX_RANGE_DAYS = 366

export const TIME_RANGE_PRESETS = [
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: '1y', label: 'Last 1 year', days: 365 },
]

export const DEFAULT_TIME_RANGE = { preset: '30d' }

const startOfUtcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
const toDateString = (ms) => new Date(ms).toISOString().slice(0, 10)
const parseDate = (dateString) => Date.parse(`${dateString}T00:00:00.000Z`)

/** Today's UTC date, YYYY-MM-DD. */
export const utcToday = (now = new Date()) => toDateString(startOfUtcDay(now))

/** The first and last day a range covers (both included), YYYY-MM-DD. */
export function rangeDays(range, now = new Date()) {
  if (range.custom) return range.custom
  const { days } = TIME_RANGE_PRESETS.find((preset) => preset.id === range.preset)
  return { from: toDateString(startOfUtcDay(now) - (days - 1) * DAY), to: utcToday(now) }
}

/**
 * The /ad query for a range. Presets leave out "to", so the backend counts
 * today up to now; a custom range ends at the midnight after its last day.
 */
export function toPeriod(range, now = new Date()) {
  const { from, to } = rangeDays(range, now)
  const period = { from: new Date(parseDate(from)).toISOString() }
  if (range.custom) period.to = new Date(parseDate(to) + DAY).toISOString()
  return period
}

/** Why a custom range can't be applied, or null when it can. */
export function validateCustomRange(from, to, now = new Date()) {
  if (!from || !to) return 'Choose a start and an end date.'
  if (from > to) return 'The start date must be on or before the end date.'
  if (to > utcToday(now)) return 'The end date can’t be in the future.'
  if ((parseDate(to) - parseDate(from)) / DAY + 1 > MAX_RANGE_DAYS) return `The range can be at most ${MAX_RANGE_DAYS} days.`
  return null
}

const labelFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** e.g. "Oct 22 – 28, 2026 (UTC)". */
export function formatRangeLabel(range, now = new Date()) {
  const { from, to } = rangeDays(range, now)
  // formatRange puts thin spaces around the dash; plain spaces read (and match) the same everywhere.
  const days = labelFormatter.formatRange(parseDate(from), parseDate(to)).replace(/\s*–\s*/, ' – ')
  return `${days} (UTC)`
}
