import { useCallback, useEffect, useRef, useState } from 'react'
import { METRICS } from './analyticsService.js'
import { sharedRequest } from '../../api/sharedRequest.js'

const loadingState = () => Object.fromEntries(METRICS.map((metric) => [metric, { status: 'loading', value: null, error: null }]))

/**
 * Loads the three metrics for a campaign over a period ({ from, to? }, see
 * timeRange.js). Each metric is requested independently and in parallel, so one
 * failure never hides the others. Responses for a previous campaign or period
 * (or a superseded retry) are discarded.
 */
export function useCampaignMetrics(api, campaignId, { from, to } = {}) {
  const [metrics, setMetrics] = useState(loadingState)
  const requestsRef = useRef({})

  const load = useCallback(
    (metric) => {
      // Identifies this request; a later load or unmount replaces it, and its result is then ignored.
      const request = {}
      requestsRef.current[metric] = request

      setMetrics((current) => ({ ...current, [metric]: { status: 'loading', value: null, error: null } }))

      sharedRequest(api, `${campaignId}/${metric}/${from ?? ''}/${to ?? ''}`, () => api.fetchMetric(campaignId, metric, { from, to })).then(
        (value) => {
          if (requestsRef.current[metric] !== request) return
          setMetrics((current) => ({ ...current, [metric]: { status: 'success', value, error: null } }))
        },
        (error) => {
          if (requestsRef.current[metric] !== request) return
          setMetrics((current) => ({
            ...current,
            [metric]: { status: 'error', value: null, error: error?.message || 'Request failed' },
          }))
        },
      )
    },
    [api, campaignId, from, to],
  )

  useEffect(() => {
    for (const metric of METRICS) load(metric)
    const requests = requestsRef.current
    return () => {
      for (const metric of METRICS) requests[metric] = null
    }
  }, [load])

  return { metrics, retry: load }
}
