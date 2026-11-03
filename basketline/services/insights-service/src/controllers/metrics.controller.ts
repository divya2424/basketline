import type { Request, Response } from 'express'
import { badRequest } from '@basketline/platform'
import { METRICS, type MetricName, type MetricsService } from '../services/metrics.service.ts'

/** :campaignId has already been checked to be a UUID by router.param. */
type WithCampaignId = Request<{ campaignId: string; metric: string }>

const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined)

function metricOf(req: Request<{ metric: string }>): MetricName {
  const metric = req.params.metric as MetricName
  if (!METRICS.includes(metric)) throw badRequest('UNKNOWN_METRIC', 'metric must be clicks, impressions, clickToBasket, uniqueCustomers or sessions')
  return metric
}

/** Counts are per tenant, and only the caller's own: the tenant comes from the token. */
export function createMetricsController(service: MetricsService) {
  return {
    /** GET /ad/campaigns — the tenant's campaigns with activity, per store. */
    async campaigns(req: Request, res: Response) {
      res.json({ items: await service.campaigns(req.auth!.tid) })
    },

    /** GET /ad/:campaignId/products?storeId — the campaign's results per product; for a campaign manager or a store's backend. */
    async products(req: Request<{ campaignId: string }>, res: Response) {
      const { campaignId } = req.params
      const storeId = queryString(req.query.storeId)?.toLowerCase()
      const tenantId = req.integration?.tid ?? req.auth!.tid
      const { items, period } = await service.products(tenantId, campaignId, { from: queryString(req.query.from), to: queryString(req.query.to), storeId })
      res.json({ campaignId, ...(storeId ? { storeId } : {}), items, period: { from: period.from.toISOString(), to: period.to.toISOString() } })
    },

    /** GET /ad/:campaignId/:metric?storeId — response shape preserved from the frontend contract. */
    async metric(req: WithCampaignId, res: Response) {
      const metric = metricOf(req)
      const { campaignId } = req.params
      const storeId = queryString(req.query.storeId)?.toLowerCase()
      const { count, customers, columns, period } = await service.count(req.auth!.tid, campaignId, metric, {
        from: queryString(req.query.from),
        to: queryString(req.query.to),
        storeId,
      })
      // customers is what the API's spec asks for ("the number of customers who
      // clicked"); count is the event total, for rates such as CTR. The columns
      // split both (e.g. total_web_clicks, customers_registered_clicks).
      res.json({
        campaignId,
        ...(storeId ? { storeId } : {}),
        metric,
        count,
        ...(customers === undefined ? {} : { customers }),
        ...columns,
        period: { from: period.from.toISOString(), to: period.to.toISOString() },
      })
    },
  }
}

export type MetricsController = ReturnType<typeof createMetricsController>
