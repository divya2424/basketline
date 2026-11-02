import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@basketline/platform'
import type { MetricsController } from '../controllers/metrics.controller.ts'
import { validateMetricQuery } from '../validators/metric.validator.ts'

/**
 * Mounted at /api/v1/ad: GET /:campaignId/<metric> and /sellers/:sellerId/<metric> (clicks, impressions,
 * clickToBasket, uniqueCustomers, sessions), for campaign managers and seller-managers (their own seller).
 */
export function adMetricRoutes(metrics: MetricsController, authenticate: RequestHandler): Router {
  const router = Router()
  router.param('campaignId', uuidParam)
  router.param('sellerId', uuidParam)
  const reader = requireRole('campaign-manager', 'seller-manager')
  // Before /:campaignId, so "sellers" is never read as a campaign ID.
  router.get('/sellers/:sellerId/:metric', authenticate, reader, validate(validateMetricQuery, 'query'), metrics.sellerMetric)
  router.get('/:campaignId/:metric', authenticate, reader, validate(validateMetricQuery, 'query'), metrics.metric)
  return router
}
