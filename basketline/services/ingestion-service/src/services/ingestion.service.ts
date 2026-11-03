import { ANALYTICS_EVENT_TYPE, eventTypeOf, externalId, METRIC_EVENT_NAMES, NO_STORE, topicOf, type AnalyticsEventPayload } from '@basketline/contracts'
import { AppError, serviceUnavailable, type BusMessage, type EventBus, type Logger, type Sender } from '@basketline/platform'
import type { IncomingEvent } from '../validators/analytics.validator.ts'
import type { CampaignDirectory } from './campaign.directory.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/**
 * Late arrivals older than this are rejected (keeps reports stable). ClickHouse
 * stages events for 3 days (01_tables.sql TTL), and the hourly check recounts a
 * late event's day from them, so a late event is still counted exactly.
 */
export const MAX_EVENT_AGE_MS = 2 * 24 * HOUR
/** Allowed client clock skew. */
export const MAX_CLOCK_SKEW_MS = 5 * MINUTE
/** Events one user or visitor may send per minute (per instance); more is not a shopper. */
export const MAX_EVENTS_PER_SENDER_PER_MINUTE = 300
/**
 * Events one tenant may send per minute, by its account tier (per instance, like
 * the sender limit: across N instances a tenant gets N times this). A busy
 * tenant is held to its share, so the others' events keep flowing. The tier
 * comes from the visitor or shopper token; a token without one counts as free.
 */
export const TENANT_EVENTS_PER_MINUTE: Record<string, number> = { free: 60_000, pro: 600_000, enterprise: 6_000_000 }
/**
 * Declared bots and automation, by user agent (general invalid traffic): search
 * and social crawlers, headless browsers, audit and uptime tools. Their batches
 * are rejected (INVALID_TRAFFIC) and logged. Generic HTTP clients (curl, okhttp,
 * Java) are not on the list: mobile apps send them.
 */
const BOT_USER_AGENT = /bot\b|bot\/|crawl|spider|slurp|headless|phantomjs|lighthouse|pingdom|uptimerobot|facebookexternalhit/i

export type IngestResult = { eventId: string; status: 'accepted' } | { eventId: string; status: 'rejected'; reason: string }

/**
 * Publishes each valid event to its topic (interactions or identity), with the
 * store it came from. An impression or click counts only for one of the tenant's
 * active campaigns (`campaigns`, a cached lookup); else it's rejected
 * (UNKNOWN_CAMPAIGN). Nothing else is looked up here: the Flink job
 * (basketline/flink) credits basket additions to their click and writes both to
 * ClickHouse, which removes duplicates and keeps the daily totals.
 */
export function createIngestionService({
  bus,
  logger,
  campaigns,
  maxEventsPerMinute = MAX_EVENTS_PER_SENDER_PER_MINUTE,
  tenantEventsPerMinute = TENANT_EVENTS_PER_MINUTE,
}: {
  bus: EventBus
  logger: Logger
  campaigns: CampaignDirectory
  maxEventsPerMinute?: number
  tenantEventsPerMinute?: Record<string, number>
}) {
  let window = { start: 0, counts: new Map<string, number>() }
  let tenantWindow = { start: 0, counts: new Map<string, number>() }

  /** Fixed one-minute windows per sender. */
  function assertWithinLimit(sender: Sender, count: number, now: number) {
    if (now - window.start >= MINUTE) window = { start: now, counts: new Map() }
    const used = window.counts.get(sender.userId) ?? 0
    if (used + count > maxEventsPerMinute) {
      const retryAfter = Math.ceil((window.start + MINUTE - now) / 1000)
      throw new AppError(429, 'TOO_MANY_EVENTS', `At most ${maxEventsPerMinute} events per minute`, undefined, retryAfter)
    }
    window.counts.set(sender.userId, used + count)
  }

  /** Fixed one-minute windows per tenant, sized by its tier. */
  function assertTenantWithinBudget(tenantId: string, tier: string | null, count: number, now: number) {
    const budget = (tier && tenantEventsPerMinute[tier]) || tenantEventsPerMinute.free!
    if (now - tenantWindow.start >= MINUTE) tenantWindow = { start: now, counts: new Map() }
    const used = tenantWindow.counts.get(tenantId) ?? 0
    if (used + count > budget) {
      const retryAfter = Math.ceil((tenantWindow.start + MINUTE - now) / 1000)
      throw new AppError(429, 'TENANT_RATE_LIMITED', `This tenant may send at most ${budget} events per minute`, undefined, retryAfter)
    }
    tenantWindow.counts.set(tenantId, used + count)
  }

  function toMessage(event: IncomingEvent, sender: Sender, storeId: string, receivedAt: string): BusMessage {
    const { campaignId: sentCampaign, productId: sentProduct, ...properties } = event.properties ?? {}
    // IDs are lowercased or mapped here, once (a store's own IDs become UUIDs:
    // externalId), so every consumer (Flink joins on them as text) sees one form.
    const eventId = event.eventId.toLowerCase()
    const payload: AnalyticsEventPayload = {
      eventId,
      eventType: eventTypeOf(event.eventName),
      eventName: event.eventName,
      campaignId: sentCampaign ? externalId(sender.tenantId, 'campaign', sentCampaign) : null,
      productId: sentProduct ? externalId(sender.tenantId, 'product', sentProduct) : null,
      storeId: event.storeId ? externalId(sender.tenantId, 'seller', event.storeId) : storeId,
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
      topic: topicOf(event.eventName),
      key: eventId,
      envelope: {
        // The client's eventId, so a retried event keeps the same ID all the way to ClickHouse.
        eventId,
        eventType: ANALYTICS_EVENT_TYPE,
        eventVersion: 1,
        occurredAt: payload.timestamp,
        producer: 'ingestion-service',
        aggregateId: eventId,
        aggregateVersion: 1,
        payload,
      },
    }
  }

  return {
    /** storeId: the batch's store (seller) as the client sent it (its own ID or a UUID), for events without their own; without either, NO_STORE. */
    async ingest(events: IncomingEvent[], sender: Sender, userAgent = '', storeId?: string): Promise<IngestResult[]> {
      const now = Date.now()
      if (BOT_USER_AGENT.test(userAgent)) {
        logger.info({ tenantId: sender.tenantId, events: events.length, reason: 'bot_user_agent' }, 'invalid traffic rejected')
        return events.map((event) => ({ eventId: event.eventId, status: 'rejected', reason: 'INVALID_TRAFFIC' }))
      }
      assertWithinLimit(sender, events.length, now)
      assertTenantWithinBudget(sender.tenantId, sender.tier, events.length, now)
      const receivedAt = new Date(now).toISOString()
      const store = storeId ? externalId(sender.tenantId, 'seller', storeId) : NO_STORE

      const results: IngestResult[] = []
      const messages: BusMessage[] = []
      for (const event of events) {
        const time = Date.parse(event.timestamp)
        if (time > now + MAX_CLOCK_SKEW_MS || time < now - MAX_EVENT_AGE_MS) {
          results.push({ eventId: event.eventId, status: 'rejected', reason: 'TIMESTAMP_OUT_OF_RANGE' })
          continue
        }
        const message = toMessage(event, sender, store, receivedAt)
        const { campaignId } = message.envelope.payload as AnalyticsEventPayload
        if ((METRIC_EVENT_NAMES as readonly string[]).includes(event.eventName) && !(await campaigns.isActive(sender.tenantId, campaignId!))) {
          results.push({ eventId: event.eventId, status: 'rejected', reason: 'UNKNOWN_CAMPAIGN' })
          continue
        }
        messages.push(message)
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
