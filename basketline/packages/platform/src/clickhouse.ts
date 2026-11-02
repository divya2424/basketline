/**
 * The ClickHouse client of the services that use it (ingestion-service writes,
 * insights-service reads): imported as @basketline/platform/clickhouse, so the
 * others don't load it.
 */
import { createClient, type ClickHouseClient } from '@clickhouse/client'

export type ClickHouse = ClickHouseClient

/** e.g. http://user:password@clickhouse:8123/analytics (the path is the database). */
export function createClickHouse(url: string): ClickHouse {
  return createClient({ url, clickhouse_settings: { date_time_output_format: 'iso' } })
}

/** Throws if ClickHouse can't be reached (readiness probe). */
export async function pingClickHouse(client: ClickHouse): Promise<void> {
  const result = await client.ping()
  if (!result.success) throw result.error
}
