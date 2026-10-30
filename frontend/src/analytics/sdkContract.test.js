import { describe, expect, it } from 'vitest'
import { EVENT_NAMES, METRIC_EVENTS } from '@divya2424/basketline-sdk'
import { ANALYTICS_EVENT_NAMES, METRIC_EVENT_NAMES } from '../../../backend/packages/contracts/src/analytics.ts'

describe('the installed Basketline SDK', () => {
  it("sends exactly the event names the API accepts (backend/packages/contracts), so it can't drift from it", () => {
    expect([...EVENT_NAMES].sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
    expect([...METRIC_EVENTS].sort()).toEqual([...METRIC_EVENT_NAMES].sort())
  })
})
