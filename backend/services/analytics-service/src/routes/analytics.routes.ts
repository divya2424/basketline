import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@ecommerce-analytics/platform'
import type { IngestionController } from '../controllers/ingestion.controller.ts'
import type { MetricsController } from '../controllers/metrics.controller.ts'
import { validateIngest, validateMetricQuery } from '../validators/analytics.validator.ts'

/** Mounted at /api/v1/analytics. Anonymous visitors send events with a visitor token. */
export function analyticsRoutes(ingestion: IngestionController, authenticateEvents: RequestHandler): Router {
  const router = Router()
  router.post('/events', authenticateEvents, validate(validateIngest), ingestion.ingest)
  return router
}

/** Mounted at /api/v1/ad: GET /:campaignId/clicks | impressions | clickToBasket, for campaign managers. */
export function adMetricRoutes(metrics: MetricsController, authenticate: RequestHandler): Router {
  const router = Router()
  router.param('campaignId', uuidParam)
  router.get('/:campaignId/:metric', authenticate, requireRole('campaign-manager'), validate(validateMetricQuery, 'query'), metrics.metric)
  return router
}
