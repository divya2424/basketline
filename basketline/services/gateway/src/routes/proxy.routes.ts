import type { Request, RequestHandler } from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { CALLER_HEADER, type Logger } from '@basketline/platform'

export interface ServiceUrls {
  auth: string
  /** The write path: events from the SDK, reference data from stores' backends. */
  ingestion: string
  /** The read path: the insights API. */
  insights: string
}

/**
 * One proxy per service. Each request goes to exactly one service and the
 * response is passed back unchanged — the gateway never combines responses.
 * Every forwarded request loses any client-supplied CALLER_HEADER here and gets
 * one only from the caller the access middleware verified (req.caller).
 */
export function proxyRoutes(urls: ServiceUrls, logger: Logger): RequestHandler[] {
  const proxy = (pathFilter: string[], target: string) =>
    createProxyMiddleware({
      target,
      pathFilter,
      changeOrigin: true,
      proxyTimeout: 10_000,
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.removeHeader(CALLER_HEADER)
          const { caller } = req as Request
          if (caller) proxyReq.setHeader(CALLER_HEADER, JSON.stringify(caller))
        },
        error: (error, req, res) => {
          logger.error({ err: error, target, url: req.url }, 'upstream request failed')
          if ('writeHead' in res && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'The service is unavailable; try again shortly' } }))
          }
        },
      },
    })

  return [
    proxy(['/api/v1/auth', '/api/v1/accounts'], urls.auth),
    proxy(['/api/v1/analytics', '/api/v1/retail'], urls.ingestion),
    proxy(['/api/v1/ad'], urls.insights),
  ]
}
