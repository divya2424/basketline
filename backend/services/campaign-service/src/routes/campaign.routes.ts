import { Router, type RequestHandler } from 'express'
import { requireRole, uuidParam, validate } from '@basketline/platform'
import type { CampaignController } from '../controllers/campaign.controller.ts'
import {
  validateAddProducts,
  validateCreateCampaign,
  validateListCampaignsQuery,
  validateUpdateCampaign,
} from '../validators/campaign.validator.ts'

/** Mounted at /api/v1/campaigns. */
/** Reads are public (the storefront shows campaigns to visitors); writes need a campaign manager. Both see one tenant's campaigns. */
export function campaignRoutes(
  controller: CampaignController,
  { authenticate, optionalAuth }: { authenticate: RequestHandler; optionalAuth: RequestHandler },
): Router {
  const router = Router()
  const manager = requireRole('campaign-manager')
  router.param('campaignId', uuidParam)
  router.param('productId', uuidParam)

  router.get('/', optionalAuth, validate(validateListCampaignsQuery, 'query'), controller.list)
  router.post('/', authenticate, manager, validate(validateCreateCampaign), controller.create)
  router.get('/:campaignId', optionalAuth, controller.get)
  router.patch('/:campaignId', authenticate, manager, validate(validateUpdateCampaign), controller.update)
  router.delete('/:campaignId', authenticate, manager, controller.archive)

  router.get('/:campaignId/products', optionalAuth, controller.listProducts)
  router.post('/:campaignId/products', authenticate, manager, validate(validateAddProducts), controller.addProducts)
  router.delete('/:campaignId/products/:productId', authenticate, manager, controller.removeProduct)

  return router
}
