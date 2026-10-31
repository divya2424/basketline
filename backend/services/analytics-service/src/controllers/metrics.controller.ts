import type { Request, Response } from 'express'
import { badRequest, forbidden, notFound } from '@basketline/platform'
import { METRICS, type MetricName, type MetricsService } from '../services/metrics.service.ts'

/** :campaignId and :sellerId have already been checked to be UUIDs by router.param. */
type WithCampaignId = Request<{ campaignId: string; metric: string }>
type WithSellerId = Request<{ sellerId: string; metric: string }>

const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined)

function metricOf(req: Request<{ metric: string }>): MetricName {
  const metric = req.params.metric as MetricName
  if (!METRICS.includes(metric)) throw badRequest('UNKNOWN_METRIC', 'metric must be clicks, impressions, clickToBasket, uniqueCustomers or sessions')
  return metric
}

/**
 * Counts are per tenant, and only the caller's own: the tenant comes from the
 * token. A campaign manager sees every seller; a seller-manager only its own
 * seller (the token's sel).
 */
export function createMetricsController(service: MetricsService) {
  async function respond(req: Request, res: Response, campaignIds: string[], metric: MetricName, scope: object) {
    const { count, customers, columns, period } = await service.count(req.auth!.tid, campaignIds, metric, queryString(req.query.from), queryString(req.query.to))
    // count is the total and customers the people behind it; the columns split
    // them (e.g. total_web_clicks, customers_registered_clicks).
    res.json({ ...scope, metric, count, ...(customers === undefined ? {} : { customers }), ...columns, period: { from: period.from.toISOString(), to: period.to.toISOString() } })
  }

  return {
    /** GET /ad/:campaignId/:metric — response shape preserved from the frontend contract. */
    async metric(req: WithCampaignId, res: Response) {
      const metric = metricOf(req)
      const { campaignId } = req.params
      // Another seller's campaign is "not found" for a seller-manager: its existence isn't revealed.
      if (req.auth!.role === 'seller-manager' && (await service.campaignSeller(req.auth!.tid, campaignId)) !== req.auth!.sel) {
        throw notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found')
      }
      await respond(req, res, [campaignId], metric, { campaignId })
    },

    /** GET /ad/sellers/:sellerId/:metric — a seller's totals across its campaigns. */
    async sellerMetric(req: WithSellerId, res: Response) {
      const metric = metricOf(req)
      const { sellerId } = req.params
      if (req.auth!.role === 'seller-manager' && sellerId !== req.auth!.sel) throw forbidden('FORBIDDEN', 'A seller-manager sees only its own seller')
      const campaignIds = await service.sellerCampaigns(req.auth!.tid, sellerId)
      await respond(req, res, campaignIds, metric, { sellerId, campaigns: campaignIds.length })
    },
  }
}

export type MetricsController = ReturnType<typeof createMetricsController>
