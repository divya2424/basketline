import { validateEvent } from './eventSchema.js'
import { createMemoryTransport } from './eventTransport.js'
import { getRequestContext } from '../api/requestContext.js'

// Local development collector: keeps events in memory and logs them in dev.
export const localCollector = createMemoryTransport({ log: import.meta.env.DEV && import.meta.env.MODE !== 'test' })

let transport = localCollector

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  // Lets you inspect captured events from the browser console:
  //   __shopsphereAnalytics.getEvents()
  window.__shopsphereAnalytics = localCollector
}

export function setTransport(nextTransport) {
  transport = nextTransport
}

/**
 * UUID for events (the analytics API requires UUID event IDs, and rejects the
 * whole batch otherwise). Throws outside a secure context; trackEvent then drops
 * just that event.
 */
export function randomEventId() {
  return crypto.randomUUID()
}

/**
 * Builds a complete event. The ID, timestamp, tenantId and userId are always
 * added here, so components never pass identity themselves.
 */
export function createEvent({ featureName, pageName, eventName, properties = {} }) {
  const { tenantId, userId } = getRequestContext()
  return {
    eventId: randomEventId(),
    tenantId,
    userId,
    featureName,
    pageName,
    eventName,
    timestamp: new Date().toISOString(),
    properties: { ...properties },
  }
}

function reportFailure(message, detail) {
  if (import.meta.env.MODE !== 'test') console.warn(`[analytics] ${message}`, detail)
}

/**
 * Records an analytics event. Never throws and never rejects: tracking must not
 * break shopping. Returns the event that was handed to the transport, or null
 * when the event was invalid or could not be built.
 */
export function trackEvent(input) {
  let event
  try {
    event = createEvent(input)
    const errors = validateEvent(event)
    if (errors.length > 0) {
      reportFailure('invalid event dropped', { input, errors })
      return null
    }
  } catch (error) {
    reportFailure('could not build event', error)
    return null
  }

  try {
    const result = transport.send(event)
    if (result && typeof result.then === 'function') {
      result.then(undefined, (error) => reportFailure('delivery failed', error))
    }
  } catch (error) {
    reportFailure('delivery failed', error)
  }
  return event
}
