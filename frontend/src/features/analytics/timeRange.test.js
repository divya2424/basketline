import { describe, expect, it } from 'vitest'
import { formatRangeLabel, toPeriod, utcToday, validateCustomRange } from './timeRange.js'

const now = new Date('2026-10-28T10:00:00.000Z')

describe('timeRange', () => {
  it('starts each preset at UTC midnight, counting today, with an open end', () => {
    expect(toPeriod({ preset: '7d' }, now)).toEqual({ from: '2026-10-22T00:00:00.000Z' })
    expect(toPeriod({ preset: '30d' }, now)).toEqual({ from: '2026-09-29T00:00:00.000Z' })
    expect(toPeriod({ preset: '90d' }, now)).toEqual({ from: '2026-07-31T00:00:00.000Z' })
    expect(toPeriod({ preset: '1y' }, now)).toEqual({ from: '2025-10-29T00:00:00.000Z' })
  })

  it('includes both days of a custom range: it ends at the midnight after the last one', () => {
    expect(toPeriod({ custom: { from: '2026-10-01', to: '2026-10-10' } }, now)).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-11T00:00:00.000Z',
    })
  })

  it('uses the UTC date for today, whatever the local time zone', () => {
    expect(utcToday(new Date('2026-10-28T23:30:00.000Z'))).toBe('2026-10-28')
  })

  it('rejects incomplete, inverted, future and over-long custom ranges', () => {
    expect(validateCustomRange('', '2026-10-10', now)).toBe('Choose a start and an end date.')
    expect(validateCustomRange('2026-10-10', '2026-10-01', now)).toBe('The start date must be on or before the end date.')
    expect(validateCustomRange('2026-10-01', '2026-10-29', now)).toBe('The end date can’t be in the future.')
    expect(validateCustomRange('2025-10-27', '2026-10-28', now)).toBe('The range can be at most 366 days.')
    expect(validateCustomRange('2025-10-28', '2026-10-28', now)).toBeNull()
    expect(validateCustomRange('2026-10-28', '2026-10-28', now)).toBeNull()
  })

  it('labels the days a range covers', () => {
    expect(formatRangeLabel({ preset: '7d' }, now)).toBe('Oct 22 – 28, 2026 (UTC)')
    expect(formatRangeLabel({ custom: { from: '2026-09-01', to: '2026-10-01' } }, now)).toBe('Sep 1 – Oct 1, 2026 (UTC)')
  })
})
