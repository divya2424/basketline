import { useCallback, useEffect, useRef, useState } from 'react'
import { METRICS } from './analyticsService.js'
import { sharedRequest } from '../../api/sharedRequest.js'

const loading = { status: 'loading', value: null, byClientType: null, byUserType: null, customers: null, sessionStats: null, error: null }
const loadingState = () => Object.fromEntries(METRICS.map((metric) => [metric, loading]))

/**
 * How often visible counts are fetched again. With the API's 15 s cache and the
 * pipeline's delay, the numbers shown are at most about a minute old.
 */
export const REFRESH_MS = 20_000

/**
 * Loads the metrics for a campaign over a period ({ from, to? }, see
 * timeRange.js): each one's total (value) and its split by client type
 * (byClientType: { web, mobile }, plus both for unique customers, or null), the
 * customers behind it (customers) and their split by user type (byUserType:
 * { registered, visitor }), and for sessions the converted ones and their
 * average duration (sessionStats). Each metric is requested independently and in parallel, so one
 * failure never hides the others. Responses for a previous campaign or period
 * (or a superseded retry) are discarded.
 *
 * Every REFRESH_MS, while the page is visible, the counts are fetched again
 * quietly: the shown values stay until the new ones arrive, and a failed refresh
 * keeps them (the next one tries again).
 */
export function useCampaignMetrics(api, campaignId, { from, to } = {}) {
  const [metrics, setMetrics] = useState(loadingState)
  const requestsRef = useRef({})

  const load = useCallback(
    (metric, quiet = false) => {
      // Identifies this request; a later load or unmount replaces it, and its result is then ignored.
      const request = {}
      requestsRef.current[metric] = request

      if (!quiet) setMetrics((current) => ({ ...current, [metric]: loading }))

      sharedRequest(api, `${campaignId}/${metric}/${from ?? ''}/${to ?? ''}`, () => api.fetchMetric(campaignId, metric, { from, to })).then(
        ({ count, byClientType, byUserType = null, customers = null, sessionStats = null }) => {
          if (requestsRef.current[metric] !== request) return
          setMetrics((current) => ({
            ...current,
            [metric]: { status: 'success', value: count, byClientType, byUserType, customers, sessionStats, error: null },
          }))
        },
        (error) => {
          if (requestsRef.current[metric] !== request || quiet) return
          setMetrics((current) => ({
            ...current,
            [metric]: { ...loading, status: 'error', error: error?.message || 'Request failed' },
          }))
        },
      )
    },
    [api, campaignId, from, to],
  )

  useEffect(() => {
    for (const metric of METRICS) load(metric)
    const refresh = setInterval(() => {
      if (document.visibilityState !== 'hidden') for (const metric of METRICS) load(metric, true)
    }, REFRESH_MS)
    const requests = requestsRef.current
    return () => {
      clearInterval(refresh)
      for (const metric of METRICS) requests[metric] = null
    }
  }, [load])

  const retry = useCallback((metric) => load(metric), [load])
  return { metrics, retry }
}
