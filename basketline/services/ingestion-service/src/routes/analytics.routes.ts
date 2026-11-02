import { Router, type RequestHandler } from 'express'
import { validate } from '@basketline/platform'
import type { IngestionController } from '../controllers/ingestion.controller.ts'
import type { ReferenceController } from '../controllers/reference.controller.ts'
import { validateIngest } from '../validators/analytics.validator.ts'
import { validateCampaigns, validateCatalog, validateIdentity } from '../validators/reference.validator.ts'

/** Mounted at /api/v1/analytics. Anonymous visitors send events with a visitor token. */
export function analyticsRoutes(ingestion: IngestionController, authenticateEvents: RequestHandler): Router {
  const router = Router()
  router.post('/events', authenticateEvents, validate(validateIngest), ingestion.ingest)
  return router
}

/**
 * Mounted at /api/v1/retail: reference data and server-side identity from a store's
 * backend, with an integration token (its API key, exchanged at POST /auth/integration-token).
 */
export function referenceRoutes(reference: ReferenceController, authenticateIntegration: RequestHandler): Router {
  const router = Router()
  router.post('/catalog', authenticateIntegration, validate(validateCatalog), reference.publish)
  router.post('/campaigns', authenticateIntegration, validate(validateCampaigns), reference.publish)
  router.post('/identity', authenticateIntegration, validate(validateIdentity), reference.publish)
  return router
}
