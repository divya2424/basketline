import type { Request, Response } from 'express'
import { badRequest } from '@basketline/platform'
import { METRICS, type MetricName, type MetricsService } from '../services/metrics.service.ts'

/** :campaignId has already been checked to be a UUID by router.param. */
type WithCampaignId = Request<{ campaignId: string; metric: string }>

const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined)

export function createMetricsController(service: MetricsService) {
  return {
    /** GET /ad/:campaignId/:metric — response shape preserved from the frontend contract. */
    async metric(req: WithCampaignId, res: Response) {
      const metric = req.params.metric as MetricName
      if (!METRICS.includes(metric)) throw badRequest('UNKNOWN_METRIC', 'metric must be clicks, impressions, clickToBasket, uniqueCustomers or sessions')
      // Counts are per tenant, and only the caller's own: the tenant comes from the token.
      const { campaignId } = req.params
      const { count, customers, columns, period } = await service.count(req.auth!.tid, campaignId, metric, queryString(req.query.from), queryString(req.query.to))
      // count is the total and customers the people behind it; the columns split
      // them (e.g. total_web_clicks, customers_registered_clicks).
      res.json({ campaignId, metric, count, ...(customers === undefined ? {} : { customers }), ...columns, period: { from: period.from.toISOString(), to: period.to.toISOString() } })
    },
  }
}

export type MetricsController = ReturnType<typeof createMetricsController>
