import { describe, expect, it, vi } from 'vitest'
import { createEvent, localCollector, setTransport, trackEvent } from './analytics.js'
import { DEFAULT_TENANT_ID, setRequestTenant, setRequestUser } from '../api/requestContext.js'
import { isIsoUtcTimestamp, validateEvent } from './eventSchema.js'

const input = { featureName: 'product_card', pageName: 'home', eventName: 'add_to_cart', properties: { productId: 'product_001', quantity: 1 } }

describe('trackEvent', () => {
  it('builds events with every required field', () => {
    const event = trackEvent(input)
    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'eventName',
      'featureName',
      'pageName',
      'properties',
      'tenantId',
      'timestamp',
      'userId',
    ])
    expect(event).toMatchObject(input)
    expect(localCollector.getEvents()).toEqual([event])
  })

  it('generates unique IDs and ISO 8601 UTC timestamps centrally', () => {
    const a = createEvent(input)
    const b = createEvent(input)
    expect(a.eventId).not.toBe(b.eventId)
    expect(isIsoUtcTimestamp(a.timestamp)).toBe(true)
    expect(a.timestamp.endsWith('Z')).toBe(true)
  })

  it('drops invalid events instead of sending them', () => {
    expect(trackEvent({ ...input, eventName: 'made_up' })).toBeNull()
    expect(trackEvent({ ...input, pageName: '' })).toBeNull()
    expect(trackEvent({ ...input, properties: { email: 'a@b.c' } })).toBeNull()
    expect(localCollector.getEvents()).toHaveLength(0)
  })

  it('never throws when the transport throws or rejects', async () => {
    setTransport({ send: () => { throw new Error('boom') } })
    expect(() => trackEvent(input)).not.toThrow()

    const rejection = vi.fn(() => Promise.reject(new Error('offline')))
    setTransport({ send: rejection })
    expect(() => trackEvent(input)).not.toThrow()
    await Promise.resolve()
    expect(rejection).toHaveBeenCalledOnce()
  })
})

describe('tenant and user identity on events', () => {
  it('adds tenantId always and userId only when signed in', () => {
    expect(trackEvent(input)).toMatchObject({ tenantId: DEFAULT_TENANT_ID, userId: null })
    setRequestTenant('tenant_acme')
    setRequestUser({ userId: 'user_1001' })
    expect(trackEvent(input)).toMatchObject({ tenantId: 'tenant_acme', userId: 'user_1001' })
  })

  it('ignores identity passed by callers', () => {
    setRequestUser({ userId: 'user_1001' })
    const event = trackEvent({ ...input, tenantId: 'spoofed', userId: 'spoofed' })
    expect(event).toMatchObject({ tenantId: DEFAULT_TENANT_ID, userId: 'user_1001' })
  })
})

describe('validateEvent', () => {
  it('requires tenantId and a string-or-null userId', () => {
    const event = createEvent(input)
    expect(validateEvent({ ...event, tenantId: '' })).toContain('tenantId must be a non-empty string')
    expect(validateEvent({ ...event, userId: undefined })).toContain('userId must be a non-empty string or null')
    expect(validateEvent({ ...event, userId: null })).toEqual([])
  })

  it('rejects non-UTC timestamps', () => {
    const event = { ...createEvent(input), timestamp: '2026-10-27T16:30:00+05:30' }
    expect(validateEvent(event)).toContain('timestamp must be an ISO 8601 UTC string')
  })
})
