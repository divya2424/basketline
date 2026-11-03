import type { CryptoKey } from 'jose'
import { Counter } from 'prom-client'
import {
  authenticateEvents,
  authenticateIntegration,
  createBaseApp,
  createHealth,
  errorHandler,
  notFoundHandler,
  type EventBus,
  type Health,
  type Logger,
} from '@basketline/platform'
import { pingClickHouse, type ClickHouse } from '@basketline/platform/clickhouse'
import { createIngestionController } from './controllers/ingestion.controller.ts'
import { createReferenceController } from './controllers/reference.controller.ts'
import { analyticsRoutes, referenceRoutes } from './routes/analytics.routes.ts'
import type { CampaignDirectory } from './services/campaign.directory.ts'
import { createIngestionService } from './services/ingestion.service.ts'
import { createReferenceService } from './services/reference.service.ts'

export interface IngestionAppDeps {
  bus: EventBus
  /** For the readiness probe: the consumers (index.ts) apply deletions there. */
  clickhouse: ClickHouse
  logger: Logger
  publicKey: CryptoKey
  /** The tenants' active campaigns: impressions and clicks for any other campaign are rejected. */
  campaigns: CampaignDirectory
  /** Events one sender may send per minute (default MAX_EVENTS_PER_SENDER_PER_MINUTE). */
  maxEventsPerMinute?: number
  /** Events one tenant may send per minute, by tier (default TENANT_EVENTS_PER_MINUTE). */
  tenantEventsPerMinute?: Record<string, number>
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/**
 * The write path: events from stores' sites and apps (the SDK) and reference
 * data from their backends (the retail API), validated and published to Kafka.
 * Builds the Express app: services → controllers → routes.
 */
export function buildIngestionApp({
  bus,
  clickhouse,
  logger,
  publicKey,
  campaigns,
  maxEventsPerMinute,
  tenantEventsPerMinute,
  health = createHealth({ started: true }),
}: IngestionAppDeps) {
  health.addCheck('clickhouse', () => pingClickHouse(clickhouse))
  const app = createBaseApp({ name: 'ingestion-service', logger, health })

  const events = new Counter({
    name: 'ingestion_events_total',
    help: 'Events received, by outcome (accepted, rejected) and rejection reason',
    labelNames: ['outcome', 'reason'] as const,
    registers: [app.locals.metrics],
  })
  const ingestion = createIngestionController(createIngestionService({ bus, logger, campaigns, maxEventsPerMinute, tenantEventsPerMinute }), events)

  app.use('/api/v1/analytics', analyticsRoutes(ingestion, authenticateEvents(publicKey)))
  app.use('/api/v1/retail', referenceRoutes(createReferenceController(createReferenceService({ bus, logger })), authenticateIntegration(publicKey)))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
