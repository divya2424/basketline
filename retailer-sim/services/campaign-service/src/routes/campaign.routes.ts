import { Router, type RequestHandler } from 'express'
import { uuidParam, validate } from '@basketline/platform'
import { requireStaffOrSeller } from '@retailer-sim/shared'
import type { CampaignController } from '../controllers/campaign.controller.ts'
import {
  validateAddProducts,
  validateCreateCampaign,
  validateListCampaignsQuery,
  validateResultsQuery,
  validateUpdateCampaign,
} from '../validators/campaign.validator.ts'

/** Mounted at /api/v1/campaigns. */
/**
 * Reads are public (the storefront shows campaigns to visitors); writes need the
 * store's staff, or a seller for its own campaigns, as do a campaign's results.
 * Both see one tenant's campaigns.
 */
export function campaignRoutes(
  controller: CampaignController,
  { authenticate, optionalAuth }: { authenticate: RequestHandler; optionalAuth: RequestHandler },
): Router {
  const router = Router()
  router.param('campaignId', uuidParam)
  router.param('productId', uuidParam)

  router.get('/', optionalAuth, validate(validateListCampaignsQuery, 'query'), controller.list)
  router.post('/', authenticate, requireStaffOrSeller, validate(validateCreateCampaign), controller.create)
  router.get('/:campaignId', optionalAuth, controller.get)
  router.patch('/:campaignId', authenticate, requireStaffOrSeller, validate(validateUpdateCampaign), controller.update)
  router.delete('/:campaignId', authenticate, requireStaffOrSeller, controller.archive)
  router.get('/:campaignId/results', authenticate, requireStaffOrSeller, validate(validateResultsQuery, 'query'), controller.results)

  router.get('/:campaignId/products', optionalAuth, controller.listProducts)
  router.post('/:campaignId/products', authenticate, requireStaffOrSeller, validate(validateAddProducts), controller.addProducts)
  router.delete('/:campaignId/products/:productId', authenticate, requireStaffOrSeller, controller.removeProduct)

  return router
}
