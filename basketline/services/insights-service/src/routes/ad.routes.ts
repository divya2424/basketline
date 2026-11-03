import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@basketline/platform'
import type { MetricsController } from '../controllers/metrics.controller.ts'
import { validateMetricQuery } from '../validators/metric.validator.ts'

/**
 * Mounted at /api/v1/ad: GET /campaigns (the tenant's campaigns per store), for
 * campaign managers; and a campaign's /:campaignId/<metric>?storeId (clicks,
 * impressions, clickToBasket, uniqueCustomers, sessions) and /:campaignId/products
 * (the results per product), also for a store's backend with its integration
 * token, e.g. for its sellers' portal.
 */
export function adMetricRoutes(metrics: MetricsController, authenticate: RequestHandler, authenticateIntegration: RequestHandler): Router {
  const router = Router()
  router.param('campaignId', uuidParam)
  const reader = requireRole('campaign-manager')
  /** An integration token (the tenant's backend), else a campaign manager's access token. */
  const managerOrIntegration: RequestHandler = async (req, res, next) => {
    let integration = false
    await Promise.resolve(authenticateIntegration(req, res, () => (integration = true))).catch(() => {})
    if (integration) return next()
    await authenticate(req, res, () => reader(req, res, next))
  }
  router.get('/campaigns', authenticate, reader, metrics.campaigns)
  router.get('/:campaignId/products', managerOrIntegration, validate(validateMetricQuery, 'query'), metrics.products)
  router.get('/:campaignId/:metric', managerOrIntegration, validate(validateMetricQuery, 'query'), metrics.metric)
  return router
}
