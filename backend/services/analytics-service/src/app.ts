import type { CryptoKey } from 'jose'
import {
  authenticate,
  authenticateEvents,
  createBaseApp,
  createHealth,
  errorHandler,
  notFoundHandler,
  type EventBus,
  type Health,
  type Logger,
} from '@ecommerce-analytics/platform'
import { pingClickHouse, type ClickHouse } from './clickhouse.ts'
import { createIngestionController } from './controllers/ingestion.controller.ts'
import { createMetricsController } from './controllers/metrics.controller.ts'
import { adMetricRoutes, analyticsRoutes } from './routes/analytics.routes.ts'
import { createIngestionService } from './services/ingestion.service.ts'
import { createMetricsService } from './services/metrics.service.ts'

export interface AnalyticsAppDeps {
  bus: EventBus
  clickhouse: ClickHouse
  logger: Logger
  publicKey: CryptoKey
  /** Events one sender may send per minute (default MAX_EVENTS_PER_SENDER_PER_MINUTE). */
  maxEventsPerMinute?: number
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: services → controllers → routes. */
export function buildAnalyticsApp({ bus, clickhouse, logger, publicKey, maxEventsPerMinute, health = createHealth({ started: true }) }: AnalyticsAppDeps) {
  health.addCheck('clickhouse', () => pingClickHouse(clickhouse))
  const app = createBaseApp({ name: 'analytics-service', logger, health })

  const ingestion = createIngestionController(createIngestionService({ bus, clickhouse, logger, maxEventsPerMinute }))
  const metrics = createMetricsController(createMetricsService({ clickhouse }))

  app.use('/api/v1/analytics', analyticsRoutes(ingestion, authenticateEvents(publicKey)))
  app.use('/api/v1/ad', adMetricRoutes(metrics, authenticate(publicKey)))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
