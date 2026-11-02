/**
 * Health probes shared by all services.
 *
 *   GET /health/live     200 while the process can serve HTTP. No dependency checks,
 *                        so a slow database never gets a healthy pod restarted.
 *   GET /health/startup  200 once startup finished (migrations, Kafka consumers).
 *   GET /health/ready    200 when started, not shutting down, and every check
 *                        (database, Kafka, ...) passes within its timeout.
 */
import { Router } from 'express'

export type HealthCheck = () => Promise<unknown>

export interface Health {
  addCheck(name: string, check: HealthCheck): void
  /** Call once startup work is done; until then /health/startup and /health/ready return 503. */
  markStarted(): void
  /** Call first thing on shutdown so load balancers stop sending traffic. */
  markShuttingDown(): void
  readonly started: boolean
  readonly shuttingDown: boolean
  runChecks(): Promise<{ ok: boolean; checks: Record<string, string> }>
}

const CHECK_TIMEOUT_MS = 2_000

function withTimeout(check: HealthCheck, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer))
}

export function createHealth({ started = false, checkTimeoutMs = CHECK_TIMEOUT_MS } = {}): Health {
  const checks = new Map<string, HealthCheck>()
  let isStarted = started
  let isShuttingDown = false

  return {
    addCheck(name, check) {
      checks.set(name, check)
    },
    markStarted() {
      isStarted = true
    },
    markShuttingDown() {
      isShuttingDown = true
    },
    get started() {
      return isStarted
    },
    get shuttingDown() {
      return isShuttingDown
    },
    async runChecks() {
      const results = await Promise.all(
        [...checks].map(async ([name, check]) => {
          try {
            await withTimeout(check, checkTimeoutMs)
            return [name, 'ok'] as const
          } catch (error) {
            return [name, error instanceof Error ? error.message : 'failed'] as const
          }
        }),
      )
      return { ok: results.every(([, status]) => status === 'ok'), checks: Object.fromEntries(results) }
    },
  }
}

export function healthRoutes(name: string, health: Health): Router {
  const router = Router()

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: name })
  })

  router.get('/health/startup', (_req, res) => {
    res.status(health.started ? 200 : 503).json({ status: health.started ? 'started' : 'starting', service: name })
  })

  router.get('/health/ready', async (req, res) => {
    if (health.shuttingDown || !health.started) {
      res.status(503).json({ status: health.shuttingDown ? 'shutting_down' : 'starting', service: name })
      return
    }
    const { ok, checks } = await health.runChecks()
    if (!ok) req.log.warn({ checks }, 'readiness check failed')
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable', service: name, checks })
  })

  return router
}
