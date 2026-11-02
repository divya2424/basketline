import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@basketline/platform'
import type { MetricsController } from '../controllers/metrics.controller.ts'
import { validateMetricQuery } from '../validators/metric.validator.ts'

/**
 * Mounted at /api/v1/ad: GET /campaigns (the tenant's campaigns per store) and
 * /:campaignId/<metric>?storeId (clicks, impressions, clickToBasket, uniqueCustomers),
 * for campaign managers.
 */
export function adMetricRoutes(metrics: MetricsController, authenticate: RequestHandler): Router {
  const router = Router()
  router.param('campaignId', uuidParam)
  const reader = requireRole('campaign-manager')
  router.get('/campaigns', authenticate, reader, metrics.campaigns)
  router.get('/:campaignId/:metric', authenticate, reader, validate(validateMetricQuery, 'query'), metrics.metric)
  return router
}
