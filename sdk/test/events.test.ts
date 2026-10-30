import { describe, expect, it } from 'vitest'
import { ANALYTICS_EVENT_NAMES, METRIC_EVENT_NAMES } from '../../backend/packages/contracts/src/analytics.ts'
import { EVENT_NAMES, METRIC_EVENTS } from '../src/events'

describe('event names', () => {
  it("are exactly the ones the API accepts (backend/packages/contracts), so the SDK can't drift from it", () => {
    expect([...EVENT_NAMES].sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
    expect([...METRIC_EVENTS].sort()).toEqual([...METRIC_EVENT_NAMES].sort())
  })
})
