import { randomUUID } from 'node:crypto'
import { EVENTS, type EventEnvelope, type EventPayloads, type EventType } from '@basketline/contracts'
import type { EventBus } from '@divya2424/basketline-kafka'
import type { Logger } from './logger.ts'

export interface NewEvent<T extends EventType = EventType> {
  eventType: T
  aggregateId: string
  aggregateVersion: number
  payload: EventPayloads[T]
}

/** Helper to build a typed NewEvent. */
export function event<T extends EventType>(
  eventType: T,
  aggregateId: string,
  aggregateVersion: number,
  payload: EventPayloads[T],
): NewEvent<T> {
  return { eventType, aggregateId, aggregateVersion, payload }
}

/** Any event a publisher can send: Basketline's (NewEvent), or another registry's. */
export interface OutgoingEvent {
  eventType: string
  aggregateId: string
  aggregateVersion: number
  payload: unknown
}

export type PublishEvents = (events: OutgoingEvent[]) => Promise<void>

/** Each event type's topic and schema version. */
export type EventRegistry = Record<string, { topic: string; version: number }>

/**
 * Returns a function that publishes events to Kafka. Call it only AFTER the
 * database transaction has committed, so rolled-back writes publish nothing.
 *
 * There is no outbox: if Kafka is unreachable the events are logged and
 * dropped (the request still succeeds because the data is saved), and other
 * services' projections stay stale until that record changes again. With
 * failOnError (for CLIs) the error is rethrown instead. registry: the event
 * types' topics (default Basketline's; the simulated retailer has its own).
 */
export function createEventPublisher(
  bus: EventBus,
  producer: string,
  logger: Logger,
  { failOnError = false, registry = EVENTS as EventRegistry }: { failOnError?: boolean; registry?: EventRegistry } = {},
): PublishEvents {
  return async (events) => {
    if (events.length === 0) return
    const messages = events.map((newEvent) => {
      const definition = registry[newEvent.eventType]
      if (!definition) throw new Error(`Unknown event type ${newEvent.eventType}`)
      const envelope: EventEnvelope = {
        eventId: randomUUID(),
        eventType: newEvent.eventType,
        eventVersion: definition.version,
        occurredAt: new Date().toISOString(),
        producer,
        aggregateId: newEvent.aggregateId,
        aggregateVersion: newEvent.aggregateVersion,
        payload: newEvent.payload,
      }
      return { topic: definition.topic, key: newEvent.aggregateId, envelope }
    })
    try {
      await bus.publish(messages)
    } catch (error) {
      logger.error({ err: error, events: messages.map((m) => m.envelope) }, 'failed to publish events; they were not delivered')
      if (failOnError) throw error
    }
  }
}
