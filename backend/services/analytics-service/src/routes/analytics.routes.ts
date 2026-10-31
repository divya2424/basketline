import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@basketline/platform'
import type { IngestionController } from '../controllers/ingestion.controller.ts'
import type { MetricsController } from '../controllers/metrics.controller.ts'
import type { ReferenceController } from '../controllers/reference.controller.ts'
import { validateIngest, validateMetricQuery } from '../validators/analytics.validator.ts'
import { validateCampaigns, validateCatalog, validateIdentity } from '../validators/reference.validator.ts'

/** Mounted at /api/v1/analytics. Anonymous visitors send events with a visitor token. */
export function analyticsRoutes(ingestion: IngestionController, authenticateEvents: RequestHandler): Router {
  const router = Router()
  router.post('/events', authenticateEvents, validate(validateIngest), ingestion.ingest)
  return router
}

/**
 * Mounted at /api/v1/retail: reference data and server-side identity from a retailer's
 * backend, with an integration token (its API key, exchanged at POST /auth/integration-token).
 */
export function referenceRoutes(reference: ReferenceController, authenticateIntegration: RequestHandler): Router {
  const router = Router()
  router.post('/catalog', authenticateIntegration, validate(validateCatalog), reference.publish)
  router.post('/campaigns', authenticateIntegration, validate(validateCampaigns), reference.publish)
  router.post('/identity', authenticateIntegration, validate(validateIdentity), reference.publish)
  return router
}

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
