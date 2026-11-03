import { createHealth, createLogger, handleShutdown, intEnv, requireEnv } from '@basketline/platform'
import { createClickHouse } from '@basketline/platform/clickhouse'
import { buildInsightsApp } from './app.ts'

const logger = createLogger('insights-service')
const health = createHealth()

// The tenant-scoped reader user (infra/clickhouse/04_access.sql): this service never writes.
const clickhouse = createClickHouse(requireEnv('CLICKHOUSE_READER_URL'))
// Dashboards refresh every 20 s; reusing a count for 15 s keeps their cost flat as viewers grow.
const metricsCacheMs = intEnv('METRICS_CACHE_MS', 15_000)
const app = buildInsightsApp({ clickhouse, logger, health, metricsCacheMs })
const port = intEnv('PORT', 4005)
const server = app.listen(port, () => {
  health.markStarted()
  logger.info({ port }, 'insights-service listening')
})

handleShutdown({
  logger,
  server,
  health,
  closers: [{ name: 'clickhouse', close: () => clickhouse.close() }],
})
