import type { CryptoKey } from 'jose'
import { authenticate, createBaseApp, createHealth, errorHandler, notFoundHandler, type Health, type Logger } from '@basketline/platform'
import { pingClickHouse, type ClickHouse } from '@basketline/platform/clickhouse'
import { createMetricsController } from './controllers/metrics.controller.ts'
import { adMetricRoutes } from './routes/ad.routes.ts'
import { createMetricsService } from './services/metrics.service.ts'

export interface InsightsAppDeps {
  /** ClickHouse as the tenant-scoped reader user (infra/clickhouse/04_access.sql). */
  clickhouse: ClickHouse
  logger: Logger
  publicKey: CryptoKey
  /** How long an /ad count is reused, in ms (default 0: every request queries ClickHouse). */
  metricsCacheMs?: number
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/**
 * The read path: the public insights API (/ad). It reads ClickHouse only, as a
 * user that sees one tenant per query, and holds no write credentials and no
 * Kafka connection, so ingestion load or failures can't reach it.
 */
export function buildInsightsApp({ clickhouse, logger, publicKey, metricsCacheMs, health = createHealth({ started: true }) }: InsightsAppDeps) {
  health.addCheck('clickhouse', () => pingClickHouse(clickhouse))
  const app = createBaseApp({ name: 'insights-service', logger, health })
  const metrics = createMetricsController(createMetricsService({ clickhouse, cacheMs: metricsCacheMs }))
  app.use('/api/v1/ad', adMetricRoutes(metrics, authenticate(publicKey)))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
