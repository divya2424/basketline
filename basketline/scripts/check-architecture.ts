/**
 * Enforces the PRD's architecture rules:
 *   1. No service except the gateway makes HTTP calls (no API-to-API calls).
 *   2. No service imports another service's code.
 *   3. Each service's DATABASE_URL in its folder's docker-compose.yml points at its own database.
 *      ingestion-service and insights-service have no Postgres database: they use ClickHouse.
 * Covers the platform (basketline/) and the simulated retailer (retailer-sim/).
 *
 *   pnpm check:architecture
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const repo = path.join(import.meta.dirname, '..', '..')

/** The simulated retailer's services, in retailer-sim/; the rest are Basketline's, in basketline/. */
const RETAILER_SERVICES = new Set(['product-service', 'campaign-service'])
/** The folder holding the service's services/ and docker-compose.yml. */
const folderOf = (service: string) => path.join(repo, RETAILER_SERVICES.has(service) ? 'retailer-sim' : 'basketline')

/** Each service's Postgres database; null = none (ingestion-service writes to Kafka and ClickHouse; insights-service reads ClickHouse). */
export const SERVICE_DATABASES: Record<string, string | null> = {
  'auth-service': 'identity_db',
  'product-service': 'product_db',
  'campaign-service': 'campaign_db',
  'ingestion-service': null,
  'insights-service': null,
  gateway: 'gateway_db',
}

const HTTP_CLIENT_PATTERNS: [RegExp, string][] = [
  [/\bfetch\s*\(/, 'calls fetch()'],
  [/\bhttps?\.(request|get)\s*\(/, 'calls http.request/get'],
  [/from\s+['"](axios|undici|node-fetch|got|superagent|http-proxy-middleware)['"]/, 'imports an HTTP client'],
]

/** Problems found in one source file of one service. */
export function scanSource(service: string, file: string, source: string): string[] {
  const problems: string[] = []
  if (service !== 'gateway') {
    for (const [pattern, description] of HTTP_CLIENT_PATTERNS) {
      if (pattern.test(source)) problems.push(`${service}/${file} ${description} (services must communicate through Kafka events)`)
    }
  }
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const target = match[1]!
    const other = Object.keys(SERVICE_DATABASES).find(
      (name) => name !== service && (target.includes(`/services/${name}/`) || target.includes(`../${name}/`) || target === `@basketline/${name}`),
    )
    if (other) problems.push(`${service}/${file} imports code from ${other}`)
  }
  return problems
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return entry.endsWith('.ts') ? [full] : []
  })
}

export function findViolations(): string[] {
  const problems: string[] = []
  for (const service of Object.keys(SERVICE_DATABASES)) {
    const srcDir = path.join(folderOf(service), 'services', service, 'src')
    for (const file of sourceFiles(srcDir)) {
      problems.push(...scanSource(service, path.relative(srcDir, file), readFileSync(file, 'utf8')))
    }
  }

  // Each compose service block must use only its own database.
  for (const [service, database] of Object.entries(SERVICE_DATABASES)) {
    const compose = readFileSync(path.join(folderOf(service), 'docker-compose.yml'), 'utf8')
    const block = compose.split(/\n  (?=[a-z-]+:\n)/).find((part) => part.startsWith(`${service}:`))
    const url = block?.match(/DATABASE_URL:\s*(\S+)/)?.[1]
    if (database === null) {
      if (url) problems.push(`docker-compose.yml: ${service} must not have a DATABASE_URL`)
      // The write path uses ClickHouse's own user; the read path only the tenant-scoped reader.
      if (!/CLICKHOUSE(_READER)?_URL:/.test(block ?? '')) problems.push(`docker-compose.yml: ${service} has no CLICKHOUSE_URL or CLICKHOUSE_READER_URL`)
    } else if (!url) problems.push(`docker-compose.yml: ${service} has no DATABASE_URL`)
    else if (!url.endsWith(`/${database}`)) problems.push(`docker-compose.yml: ${service} must use ${database}, not ${url}`)
  }
  return problems
}

if (import.meta.main) {
  const problems = findViolations()
  if (problems.length > 0) {
    console.error(`Architecture check failed:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('Architecture check passed: no service-to-service HTTP calls, no cross-service imports, one database per service.')
}
