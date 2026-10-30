import type { EventEnvelope } from '@basketline/contracts'
import type { EventHandler } from './bus.ts'
import type { Database, Transaction } from './db.ts'
import { processedEvents } from './tables.ts'

/**
 * Wraps a Kafka handler so each event is applied once: the processed_events
 * row and the handler's changes commit in the same transaction.
 */
export function idempotentHandler<D extends Database<any>>(
  db: D,
  handler: (tx: Transaction<D>, envelope: EventEnvelope) => Promise<void>,
): EventHandler {
  return (envelope) =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(processedEvents)
        .values({ eventId: envelope.eventId, eventType: envelope.eventType })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId })
      if (inserted.length === 0) return
      await handler(tx as Transaction<D>, envelope)
    })
}
