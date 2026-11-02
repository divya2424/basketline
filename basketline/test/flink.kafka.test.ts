/**
 * The Flink job end to end: ad impressions and clicks published to the real
 * retail.interactions.v1 topic must reach ClickHouse with their store (the zero
 * store when an event has none), other events must not, and basket additions must
 * be matched with the user's
 * earlier clicks by the attribution rules (basketline/flink/sql/pipelines/02_attributed_baskets.sql)
 * with the latest click credited. The cases are shared with the history backfill
 * (airflow/tests/fixtures/attribution_cases.json), so both implementations of the
 * rule give the same answers. Needs the stack running:
 *
 *   docker compose up -d --build kafka clickhouse ingestion-service flink-streaming
 *   pnpm test:flink
 *
 * Every run uses its own tenant, so it only reads back its own rows.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANALYTICS_EVENT_TYPE, INTERACTIONS_TOPIC, NO_STORE, eventTypeOf, type AnalyticsEventName, type AnalyticsEventPayload, type UserType } from '@basketline/contracts'
import { createKafkaEventBus, createLogger, type BusMessage, type EventBus } from '@basketline/platform'
import { createClickHouse } from '@basketline/platform/clickhouse'

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const clickhouse = createClickHouse(process.env.TEST_CLICKHOUSE_URL ?? 'http://basketline:basketline_dev@localhost:8123/analytics')
const TENANT = randomUUID()
const OTHER_TENANT = randomUUID()
/** The store of the batches the events came in (here: all but one). */
const STORE = randomUUID()
const HOUR = 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

let bus: EventBus

beforeAll(async () => {
  bus = await createKafkaEventBus({ brokers: BROKERS, clientId: 'flink-test', logger: createLogger('flink-test') })
})

afterAll(async () => {
  await bus.close()
  await clickhouse.close()
})

interface TestEvent {
  eventId?: string
  eventName: AnalyticsEventName
  campaignId?: string | null
  productId?: string | null
  userId?: string
  userType?: UserType
  tenantId?: string
  /** null: a message without one, as the job may still read from before stores. */
  storeId?: string | null
  timestamp: string
}

/** Published as ingestion-service does (ingestion.service.ts). */
function message(event: TestEvent): BusMessage {
  const payload: AnalyticsEventPayload = {
    eventId: event.eventId ?? randomUUID(),
    eventName: event.eventName,
    eventType: eventTypeOf(event.eventName),
    campaignId: event.campaignId ?? null,
    productId: event.productId ?? null,
    userId: event.userId ?? randomUUID(),
    userType: event.userType ?? 'visitor',
    clientType: 'web',
    tenantId: event.tenantId ?? TENANT,
    pageName: null,
    featureName: null,
    properties: {},
    timestamp: event.timestamp,
    receivedAt: new Date().toISOString(),
    storeId: event.storeId ?? STORE,
  }
  if (event.storeId === null) delete (payload as Partial<AnalyticsEventPayload>).storeId
  return {
    topic: INTERACTIONS_TOPIC,
    key: payload.eventId,
    envelope: {
      eventId: payload.eventId,
      eventType: ANALYTICS_EVENT_TYPE,
      eventVersion: 1,
      occurredAt: payload.timestamp,
      producer: 'flink-test',
      aggregateId: payload.eventId,
      aggregateVersion: 1,
      payload,
    },
  }
}

async function rows<T>(query: string): Promise<T[]> {
  const result = await clickhouse.query({ query, query_params: { tenants: [TENANT, OTHER_TENANT] }, format: 'JSONEachRow' })
  return result.json<T>()
}

/** Polls until `done` or the timeout: ClickHouse stores what it reads from Kafka at least every 15 s. */
async function eventually<T>(attempt: () => Promise<T>, done: (result: T) => boolean, timeoutMs = 60_000) {
  const started = Date.now()
  let result = await attempt()
  while (!done(result) && Date.now() - started < timeoutMs) {
    await sleep(1_000)
    result = await attempt()
  }
  return result
}

interface Case {
  name: string
  events: { id: string; event: 'click' | 'add_to_cart'; at: number; campaign?: string; product?: string | null; user?: string; tenant?: string; userType?: UserType }[]
  credits: Record<string, string | null>
  publishLast?: string[]
}
const CASES: Case[] = JSON.parse(readFileSync(new URL('../airflow/tests/fixtures/attribution_cases.json', import.meta.url), 'utf8')).cases

describe('the Flink job', () => {
  it("stores ad impressions and clicks with their store, and matches basket additions with the user's earlier clicks on the product, crediting the latest", async () => {
    // Each case's letters as its own IDs: users, products and campaigns don't meet across cases.
    const expected: { name: string; basket: string; campaign: string | null }[] = []
    const first: TestEvent[] = []
    const last: TestEvent[] = []
    for (const c of CASES) {
      const id: Record<string, string> = { U: randomUUID(), V: randomUUID(), P: randomUUID(), Q: randomUUID(), A: randomUUID(), B: randomUUID(), T: TENANT, O: OTHER_TENANT }
      const eventIds: Record<string, string> = {}
      const campaigns: Record<string, string | null> = {}
      for (const e of c.events) {
        const product = e.product === undefined ? 'P' : e.product
        const sent: TestEvent = {
          eventId: (eventIds[e.id] = randomUUID()),
          eventName: e.event,
          campaignId: (campaigns[e.id] = e.campaign ? id[e.campaign]! : null),
          productId: product ? id[product]! : null,
          userId: id[e.user ?? 'U']!,
          userType: e.userType ?? 'visitor',
          tenantId: id[e.tenant ?? 'T']!,
          timestamp: ago(-e.at * HOUR),
        }
        ;(c.publishLast?.includes(e.id) ? last : first).push(sent)
      }
      for (const [basket, click] of Object.entries(c.credits)) {
        expected.push({ name: c.name, basket: eventIds[basket]!, campaign: click ? campaigns[click]! : null })
      }
    }

    // Stored too: an impression, and a click without a store. Not stored: activity that isn't on an ad.
    first.push(
      { eventName: 'impression', campaignId: randomUUID(), timestamp: ago(HOUR) },
      { eventName: 'click', campaignId: randomUUID(), productId: randomUUID(), storeId: null, timestamp: ago(HOUR) },
      { eventName: 'home_view', timestamp: ago(HOUR) },
      { eventName: 'click', campaignId: null, productId: randomUUID(), timestamp: ago(HOUR) },
    )
    await bus.publish(first.map(message))
    await sleep(5_000)
    await bus.publish(last.map(message))
    // ClickHouse stages 3 days (01_tables.sql TTL): the cases' older clicks are credited, then dropped.
    const staged = (event: TestEvent) => Date.parse(event.timestamp) > Date.now() - 72 * HOUR
    const adEvents = [...first, ...last].filter((event) => ['impression', 'click'].includes(event.eventName) && event.campaignId && staged(event)).length

    // Each basket addition and the campaign of its latest candidate click, as ClickHouse credits it.
    const creditedBaskets = () =>
      rows<{ id: string; campaign: string }>(`
        SELECT toString(basket_event_id) AS id, toString(argMax(campaign_id, (click_time, click_event_id))) AS campaign
        FROM attributed_baskets WHERE tenant_id IN {tenants:Array(UUID)} GROUP BY basket_event_id`)
    const credited = expected.filter((e) => e.campaign)
    await eventually(creditedBaskets, (found) => found.length >= credited.length)
    // A little longer, so a basket that shouldn't be credited would have arrived too.
    await sleep(5_000)
    const found = new Map((await creditedBaskets()).map((row) => [row.id, row.campaign]))
    for (const { name, basket, campaign } of expected) expect(found.get(basket) ?? null, name).toBe(campaign)
    expect(found.size).toBe(credited.length)

    const stored = await eventually(
      () => rows<{ events: string }>(`SELECT uniqExact(event_id) AS events FROM events WHERE tenant_id IN {tenants:Array(UUID)}`),
      ([row]) => Number(row?.events) >= adEvents,
    )
    // A little longer, so an event that shouldn't be stored would have arrived too.
    await sleep(5_000)
    expect(Number((await rows<{ events: string }>(`SELECT uniqExact(event_id) AS events FROM events WHERE tenant_id IN {tenants:Array(UUID)}`))[0]?.events)).toBe(adEvents)
    expect(Number(stored[0]?.events)).toBe(adEvents)

    // The store reaches the stored events and credited baskets.
    expect(await rows(`SELECT DISTINCT toString(store_id) AS store FROM events WHERE tenant_id IN {tenants:Array(UUID)} ORDER BY store`)).toEqual(
      [{ store: NO_STORE }, { store: STORE }].sort((a, b) => a.store.localeCompare(b.store)),
    )
    expect(await rows(`SELECT DISTINCT toString(store_id) AS store FROM attributed_baskets WHERE tenant_id IN {tenants:Array(UUID)}`)).toEqual([{ store: STORE }])
  }, 120_000)
})
