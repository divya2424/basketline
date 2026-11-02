import type { CryptoKey } from 'jose'
import {
  authenticate,
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
import { pingClickHouse, type ClickHouse } from './clickhouse.ts'
import { createIngestionController } from './controllers/ingestion.controller.ts'
import { createMetricsController } from './controllers/metrics.controller.ts'
import { createReferenceController } from './controllers/reference.controller.ts'
import { adMetricRoutes, analyticsRoutes, referenceRoutes } from './routes/analytics.routes.ts'
import { createIngestionService } from './services/ingestion.service.ts'
import { createMetricsService } from './services/metrics.service.ts'
import { createReferenceService } from './services/reference.service.ts'

export interface AnalyticsAppDeps {
  bus: EventBus
  clickhouse: ClickHouse
  /** The /ad reads' client: ClickHouse's tenant-scoped reader user (04_access.sql). Default: clickhouse. */
  readClickhouse?: ClickHouse
  logger: Logger
  publicKey: CryptoKey
  /** Events one sender may send per minute (default MAX_EVENTS_PER_SENDER_PER_MINUTE). */
  maxEventsPerMinute?: number
  /** Events one tenant may send per minute, by tier (default TENANT_EVENTS_PER_MINUTE). */
  tenantEventsPerMinute?: Record<string, number>
  /** How long an /ad count is reused, in ms (default 0: every request queries ClickHouse). */
  metricsCacheMs?: number
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: services → controllers → routes. */
export function buildAnalyticsApp({
  bus,
  clickhouse,
  readClickhouse = clickhouse,
  logger,
  publicKey,
  maxEventsPerMinute,
  tenantEventsPerMinute,
  metricsCacheMs,
  health = createHealth({ started: true }),
}: AnalyticsAppDeps) {
  health.addCheck('clickhouse', () => pingClickHouse(clickhouse))
  const app = createBaseApp({ name: 'analytics-service', logger, health })

  const ingestion = createIngestionController(createIngestionService({ bus, clickhouse, logger, maxEventsPerMinute, tenantEventsPerMinute }))
  const metrics = createMetricsController(createMetricsService({ clickhouse: readClickhouse, cacheMs: metricsCacheMs }))

  app.use('/api/v1/analytics', analyticsRoutes(ingestion, authenticateEvents(publicKey)))
  app.use('/api/v1/ad', adMetricRoutes(metrics, authenticate(publicKey)))
  app.use('/api/v1/retail', referenceRoutes(createReferenceController(createReferenceService({ bus, logger })), authenticateIntegration(publicKey)))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
