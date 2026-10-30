import type { Request, Response } from 'express'
import type { CampaignStatus } from '@basketline/contracts'
import { badRequest, page, readPagination, tenantHeader } from '@basketline/platform'
import type { Campaign } from '../repositories/campaign.repository.ts'
import type { CampaignService } from '../services/campaign.service.ts'

/** API representation: archived flag instead of the timestamp, no internal version. Dates become ISO strings in res.json. */
function toCampaignResponse({ version: _version, archivedAt, ...campaign }: Campaign) {
  return { ...campaign, archived: archivedAt !== null }
}

/**
 * The tenant whose campaigns a read sees: the signed-in user's (from the token),
 * else the storefront's tenant_id header for anonymous visitors.
 */
function readTenant(req: Request): string {
  const tenantId = req.auth?.tid ?? tenantHeader(req)
  if (!tenantId) throw badRequest('TENANT_REQUIRED', 'Sign in or send a tenant_id header (UUID)')
  return tenantId
}

/** IDs in the path have already been checked to be UUIDs by router.param. */
type WithCampaignId = Request<{ campaignId: string }>
type WithProductId = Request<{ campaignId: string; productId: string }>

export function createCampaignController(service: CampaignService) {
  return {
    async create(req: Request, res: Response) {
      const campaign = await service.create(req.auth!.tid, req.auth!.sub, req.body)
      res.status(201).location(`/api/v1/campaigns/${campaign.id}`).json(toCampaignResponse(campaign))
    },

    async list(req: Request, res: Response) {
      const { limit, offset } = readPagination(req.query)
      const { items, total } = await service.list({
        tenantId: readTenant(req),
        status: req.query.status as CampaignStatus | undefined,
        // Only campaign managers can see archived campaigns.
        includeArchived: req.query.includeArchived === 'true' && req.auth?.role === 'campaign-manager',
        limit,
        offset,
      })
      res.json(page(items.map(toCampaignResponse), total, limit, offset))
    },

    async get(req: WithCampaignId, res: Response) {
      res.json(toCampaignResponse(await service.get(readTenant(req), req.params.campaignId)))
    },

    async update(req: WithCampaignId, res: Response) {
      res.json(toCampaignResponse(await service.update(req.auth!.tid, req.auth!.sub, req.params.campaignId, req.body)))
    },

    async archive(req: WithCampaignId, res: Response) {
      res.json(toCampaignResponse(await service.archive(req.auth!.tid, req.auth!.sub, req.params.campaignId)))
    },

    async addProducts(req: WithCampaignId, res: Response) {
      const campaign = await service.addProducts(req.auth!.tid, req.auth!.sub, req.params.campaignId, req.body.productIds)
      res.status(201).json(toCampaignResponse(campaign))
    },

    async listProducts(req: WithCampaignId, res: Response) {
      const { limit, offset } = readPagination(req.query)
      const { items, total } = await service.listProducts(readTenant(req), req.params.campaignId, limit, offset)
      res.json(page(items, total, limit, offset))
    },

    async removeProduct(req: WithProductId, res: Response) {
      await service.removeProduct(req.auth!.tid, req.auth!.sub, req.params.campaignId, req.params.productId)
      res.status(204).end()
    },
  }
}

export type CampaignController = ReturnType<typeof createCampaignController>
