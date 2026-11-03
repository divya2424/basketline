/**
 * Prometheus metrics for every service (GET /metrics, scraped by
 * infra/monitoring/prometheus.yml): the RED metrics of its HTTP requests, and
 * Node's process metrics (event-loop lag, heap, GC, CPU).
 *
 * One histogram gives all three: its _count is the request rate, by
 * status_code the error rate, and its buckets the latency percentiles. The
 * route label is the route's pattern (/ad/:campaignId/:metric), never the URL,
 * so IDs don't create a series each.
 */
import { Router, type RequestHandler } from 'express'
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client'

/** Seconds, from a cache hit to a slow ClickHouse read or Kafka publish. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export interface HttpMetrics {
  /** Times each request (except /health and /metrics). */
  middleware: RequestHandler
  /** GET /metrics. */
  routes: Router
  /** For a service's own metrics, e.g. ingestion's events by outcome. */
  registry: Registry
}

/** A registry per app, so tests can build many apps in one process. */
export function createHttpMetrics(service: string): HttpMetrics {
  const registry = new Registry()
  registry.setDefaultLabels({ service })
  collectDefaultMetrics({ register: registry })
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP requests by method, route pattern and status code, and how long they took',
    labelNames: ['method', 'route', 'status_code'],
    buckets: BUCKETS,
    registers: [registry],
  })

  const middleware: RequestHandler = (req, res, next) => {
    if (req.path.startsWith('/health') || req.path === '/metrics') return next()
    const end = duration.startTimer({ method: req.method })
    // Express puts req.baseUrl back when a router passes an error on, so by the
    // time the error handler answers, the mount path is gone: keep the deepest one.
    let baseUrl = req.baseUrl
    let mount = ''
    Object.defineProperty(req, 'baseUrl', {
      configurable: true,
      enumerable: true,
      get: () => baseUrl,
      set: (value: string) => {
        baseUrl = value
        if (value.length > mount.length) mount = value
      },
    })
    res.on('finish', () => {
      // The matched route's pattern; a request no route matched (a 404, or the
      // gateway's proxies, mounted with app.use) is labelled by its mount path.
      const route = req.route ? `${mount}${req.route.path}` : mount || 'unmatched'
      end({ route, status_code: String(res.statusCode) })
    })
    next()
  }

  const routes = Router()
  routes.get('/metrics', async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics())
  })
  return { middleware, routes, registry }
}
