import type { RequestHandler } from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import type { Logger } from '@basketline/platform'

export interface ServiceUrls {
  auth: string
  product: string
  campaign: string
  analytics: string
}

/**
 * One proxy per service. Each request goes to exactly one service and the
 * response is passed back unchanged — the gateway never combines responses.
 */
export function proxyRoutes(urls: ServiceUrls, logger: Logger): RequestHandler[] {
  const proxy = (pathFilter: string[], target: string) =>
    createProxyMiddleware({
      target,
      pathFilter,
      changeOrigin: true,
      proxyTimeout: 10_000,
      on: {
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
    proxy(['/api/v1/products', '/api/v1/sellers'], urls.product),
    proxy(['/api/v1/campaigns'], urls.campaign),
    proxy(['/api/v1/ad', '/api/v1/analytics', '/api/v1/retail'], urls.analytics),
  ]
}
