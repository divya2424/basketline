import { ANALYTICS_EVENT_TYPE, analyticsTopic, METRIC_EVENT_NAMES, type AnalyticsEventPayload } from '@basketline/contracts'
import { AppError, isOneOf, serviceUnavailable, type BusMessage, type EventBus, type EventSender, type Logger } from '@basketline/platform'
import type { ClickHouse } from '../clickhouse.ts'
import { findActiveCampaigns } from '../repositories/campaign.repository.ts'
import type { IncomingEvent } from '../validators/analytics.validator.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/**
 * Late arrivals older than this are rejected (keeps reports stable). ClickHouse
 * keeps raw events for 20 days (01_tables.sql TTL), and the nightly check recounts a
 * late event's day from them, so this leaves days of margin.
 */
export const MAX_EVENT_AGE_MS = 5 * 24 * HOUR
/** Allowed client clock skew. */
export const MAX_CLOCK_SKEW_MS = 5 * MINUTE
/** Events one user or visitor may send per minute (per instance); more is not a shopper. */
export const MAX_EVENTS_PER_SENDER_PER_MINUTE = 300
/** How long a campaign's active flag is cached; a new campaign counts within about this long. */
const CAMPAIGN_CACHE_MS = 10_000
const CAMPAIGN_CACHE_MAX = 10_000

export type IngestResult = { eventId: string; status: 'accepted' } | { eventId: string; status: 'rejected'; reason: string }

/**
 * Publishes each valid event to the Kafka topic for its event name. Nothing is
 * stored here: the Flink job (backend/flink) credits basket additions to their
 * click and writes both to ClickHouse, which removes duplicates.
 *
 * Metric events count toward a campaign's /ad numbers, so they are accepted only
 * for a campaign of the sender's tenant that is active and not archived (per the
 * campaign projection).
 */
export function createIngestionService({
  bus,
  clickhouse,
  logger,
  maxEventsPerMinute = MAX_EVENTS_PER_SENDER_PER_MINUTE,
}: {
  bus: EventBus
  clickhouse: ClickHouse
  logger: Logger
  maxEventsPerMinute?: number
}) {
  const campaignCache = new Map<string, { active: boolean; until: number }>()
  let window = { start: 0, counts: new Map<string, number>() }

  /** Fixed one-minute windows per sender. */
  function assertWithinLimit(sender: EventSender, count: number, now: number) {
    if (now - window.start >= MINUTE) window = { start: now, counts: new Map() }
    const used = window.counts.get(sender.userId) ?? 0
    if (used + count > maxEventsPerMinute) {
      const retryAfter = Math.ceil((window.start + MINUTE - now) / 1000)
      throw new AppError(429, 'TOO_MANY_EVENTS', `At most ${maxEventsPerMinute} events per minute`, undefined, retryAfter)
    }
    window.counts.set(sender.userId, used + count)
  }

  /** Cached per tenant and campaign: a campaign is active only for its own tenant. */
  async function activeCampaigns(tenantId: string, ids: string[], now: number): Promise<Set<string>> {
    const key = (id: string) => `${tenantId}:${id}`
    const stale = [...new Set(ids)].filter((id) => (campaignCache.get(key(id))?.until ?? 0) <= now)
    if (stale.length > 0) {
      const active = await findActiveCampaigns(clickhouse, tenantId, stale)
      // Random campaign IDs must not grow the cache without bound.
      if (campaignCache.size + stale.length > CAMPAIGN_CACHE_MAX) campaignCache.clear()
      for (const id of stale) campaignCache.set(key(id), { active: active.has(id), until: now + CAMPAIGN_CACHE_MS })
    }
    return new Set(ids.filter((id) => campaignCache.get(key(id))?.active))
  }

  function toMessage(event: IncomingEvent, sender: EventSender, receivedAt: string): BusMessage {
    const { campaignId, productId, ...properties } = event.properties ?? {}
    // IDs are lowercased here, once, so every consumer (Flink joins on them as
    // text) sees one form; the API accepts UUIDs in either case.
    const eventId = event.eventId.toLowerCase()
    const payload: AnalyticsEventPayload = {
      eventId,
      eventName: event.eventName,
      campaignId: campaignId?.toLowerCase() ?? null,
      productId: productId?.toLowerCase() ?? null,
      userId: sender.userId,
      userType: sender.userType,
      clientType: sender.clientType,
      tenantId: sender.tenantId,
      pageName: event.pageName ?? null,
      featureName: event.featureName ?? null,
      properties,
      timestamp: new Date(event.timestamp).toISOString(),
      receivedAt,
    }
    return {
      topic: analyticsTopic(event.eventName),
      key: eventId,
      envelope: {
        // The client's eventId, so a retried event keeps the same ID all the way to ClickHouse.
        eventId,
        eventType: ANALYTICS_EVENT_TYPE,
        eventVersion: 1,
        occurredAt: payload.timestamp,
        producer: 'analytics-service',
        aggregateId: eventId,
        aggregateVersion: 1,
        payload,
      },
    }
  }

  return {
    async ingest(events: IncomingEvent[], sender: EventSender): Promise<IngestResult[]> {
      const now = Date.now()
      assertWithinLimit(sender, events.length, now)
      const receivedAt = new Date(now).toISOString()
      const isMetric = (event: IncomingEvent) => isOneOf(event.eventName, METRIC_EVENT_NAMES)
      const active = await activeCampaigns(
        sender.tenantId,
        events.filter(isMetric).map((event) => event.properties!.campaignId!.toLowerCase()),
        now,
      )

      const results: IngestResult[] = []
      const messages: BusMessage[] = []
      for (const event of events) {
        const time = Date.parse(event.timestamp)
        if (time > now + MAX_CLOCK_SKEW_MS || time < now - MAX_EVENT_AGE_MS) {
          results.push({ eventId: event.eventId, status: 'rejected', reason: 'TIMESTAMP_OUT_OF_RANGE' })
          continue
        }
        if (isMetric(event) && !active.has(event.properties!.campaignId!.toLowerCase())) {
          results.push({ eventId: event.eventId, status: 'rejected', reason: 'CAMPAIGN_NOT_ACTIVE' })
          continue
        }
        messages.push(toMessage(event, sender, receivedAt))
        results.push({ eventId: event.eventId, status: 'accepted' })
      }
      try {
        await bus.publish(messages)
      } catch (error) {
        logger.error({ err: error, count: messages.length }, 'failed to publish analytics events')
        throw serviceUnavailable('EVENTS_NOT_DELIVERED', 'Events could not be recorded right now. Try again shortly.')
      }
      return results
    },
  }
}

export type IngestionService = ReturnType<typeof createIngestionService>
