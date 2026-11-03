import { Router } from 'express'
import { gatewayCaller, uuidParam, validate } from '@basketline/platform'
import type { MetricsController } from '../controllers/metrics.controller.ts'
import { validateMetricQuery } from '../validators/metric.validator.ts'

/**
 * Mounted at /api/v1/ad: GET /campaigns (the tenant's campaigns per store), for
 * its users; and a campaign's /:campaignId/<metric>?storeId (clicks,
 * impressions, clickToBasket, uniqueCustomers, sessions) and /:campaignId/products
 * (the results per product), also for a store's backend with its integration
 * token, e.g. for its sellers' portal. The gateway checks who may call which.
 */
export function adMetricRoutes(metrics: MetricsController): Router {
  const router = Router()
  router.param('campaignId', uuidParam)
  router.use(gatewayCaller)
  router.get('/campaigns', metrics.campaigns)
  router.get('/:campaignId/products', validate(validateMetricQuery, 'query'), metrics.products)
  router.get('/:campaignId/:metric', validate(validateMetricQuery, 'query'), metrics.metric)
  return router
}
