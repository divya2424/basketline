import { randomUUID } from 'node:crypto'
import { CAMPAIGN_TOPIC, CATALOG_TOPIC, IDENTITY_TOPIC, INTERACTIONS_TOPIC, SERVING_TOPICS, TOPICS, WATERMARK_HEARTBEAT_TOPIC } from '@basketline/contracts'
import { createBusFromEnv, createHealth, createLogger, handleShutdown, intEnv, loadPublicKey, requireEnv, secretEnv } from '@basketline/platform'
import { buildAnalyticsApp } from './app.ts'
import { createClickHouse } from './clickhouse.ts'
import { handleIdentityEvent } from './events/identity.consumer.ts'
import { handleReferenceEvent } from './events/reference.consumer.ts'
import { handleTenantEvent } from './events/tenant.consumer.ts'

const logger = createLogger('analytics-service')
const health = createHealth()

// The interactions topic keeps 14 days: the Flink job keeps clicks 13 days (7-day
// attribution window + 5 days events may arrive late + a day of slack), so a replay from the
// topics can rebuild all of it. Applies when a topic is created; see
// backend/README.md for changing existing ones.
const ANALYTICS_RETENTION_MS = String(14 * 24 * 60 * 60 * 1000)
// The serving topics only bridge Flink and ClickHouse, so they keep 48 hours, enough
// to ride out a ClickHouse outage; replays come from the interactions topic.
const SERVING_RETENTION_MS = String(48 * 60 * 60 * 1000)
// A heartbeat is only useful while it is the newest time Flink has seen.
const HEARTBEAT_RETENTION_MS = String(60 * 60 * 1000)

// Reference data (sellers, products, campaigns): the latest state per ID is kept for
// good (compacted), so a rebuilt copy always has every entity.
const REFERENCE_CONFIGS = { 'cleanup.policy': 'compact' }

// Creates the topics this service publishes to (interactions, identity, reference
// data, the heartbeat) and the serving topics the Flink job writes for ClickHouse.
const bus = await createBusFromEnv('analytics-service', logger, [
  { name: INTERACTIONS_TOPIC, configs: { 'retention.ms': ANALYTICS_RETENTION_MS } },
  { name: IDENTITY_TOPIC, configs: { 'retention.ms': ANALYTICS_RETENTION_MS } },
  { name: CATALOG_TOPIC, configs: REFERENCE_CONFIGS },
  { name: CAMPAIGN_TOPIC, configs: REFERENCE_CONFIGS },
  { name: WATERMARK_HEARTBEAT_TOPIC, configs: { 'retention.ms': HEARTBEAT_RETENTION_MS } },
  ...Object.values(SERVING_TOPICS).map((name) => ({ name, configs: { 'retention.ms': SERVING_RETENTION_MS } })),
])
health.addCheck('kafka', () => bus.healthCheck())

// Every 30 s, half the Flink source's idle timeout, so the heartbeat's partition never
// counts as idle. One key, so every instance's heartbeats share one partition.
const heartbeat = setInterval(() => {
  const timestamp = new Date().toISOString()
  const envelope = { eventId: randomUUID(), eventType: 'WatermarkHeartbeat', eventVersion: 1, occurredAt: timestamp, producer: 'analytics-service', aggregateId: 'heartbeat', aggregateVersion: 1, payload: { timestamp } }
  bus.publish([{ topic: WATERMARK_HEARTBEAT_TOPIC, key: 'heartbeat', envelope }]).catch((error) => logger.warn({ err: error }, 'watermark heartbeat failed'))
}, 30_000)
const clickhouse = createClickHouse(requireEnv('CLICKHOUSE_URL'))
// The retailer's reference data (this service's copies of sellers, products and
// campaigns), erasures (user_deleted), and deleted tenants. Applying an event twice
// is harmless.
await bus.subscribe({
  groupId: 'analytics-service',
  topics: [CATALOG_TOPIC, CAMPAIGN_TOPIC, IDENTITY_TOPIC, TOPICS.tenants],
  handler: async (envelope, { topic }) => {
    if (topic.endsWith(IDENTITY_TOPIC)) return handleIdentityEvent(clickhouse, envelope)
    if (topic.endsWith(TOPICS.tenants)) return handleTenantEvent(clickhouse, envelope)
    return handleReferenceEvent(clickhouse, envelope)
  },
})

// Dashboards refresh every 20 s; reusing a count for 15 s keeps their cost flat as viewers grow.
const metricsCacheMs = intEnv('METRICS_CACHE_MS', 15_000)
const app = buildAnalyticsApp({ bus, clickhouse, logger, health, metricsCacheMs, publicKey: await loadPublicKey(secretEnv('JWT_PUBLIC_KEY')) })
const port = intEnv('PORT', 4004)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'analytics-service listening')
})

handleShutdown({
  logger,
  server,
  health,
  closers: [
    { name: 'watermark heartbeat timer', close: () => clearInterval(heartbeat) },
    { name: 'kafka', close: () => bus.close() },
    { name: 'clickhouse', close: () => clickhouse.close() },
  ],
})
