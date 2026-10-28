/**
 * Event delivery. A transport is any object with `send(event)`; it may return a
 * promise. Swap the active transport with setTransport() to send events to a
 * backend later without touching UI components.
 */
export function createMemoryTransport({ limit = 500, log = false } = {}) {
  const events = []
  return {
    send(event) {
      events.push(event)
      if (events.length > limit) events.shift()
      if (log) console.debug('[analytics]', event.eventName, event)
    },
    getEvents() {
      return events.slice()
    },
    clear() {
      events.length = 0
    },
  }
}

/** Sends each event to several transports (e.g. the local collector and the backend). */
export function createTeeTransport(transports) {
  return {
    send(event) {
      const results = transports.map((transport) => {
        try {
          return transport.send(event)
        } catch (error) {
          return Promise.reject(error)
        }
      })
      const pending = results.filter((result) => result && typeof result.then === 'function')
      return pending.length > 0 ? Promise.all(pending) : undefined
    },
  }
}
