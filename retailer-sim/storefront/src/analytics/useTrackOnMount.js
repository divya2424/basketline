import { useEffect, useEffectEvent, useRef } from 'react'
import { useAnalytics } from '../components/common/AnalyticsWrapper.jsx'

/**
 * Emits one event per mount of the calling component (one page visit). The ref
 * guard keeps StrictMode's double effect run from producing a duplicate.
 */
export function useTrackOnMount(eventName, properties) {
  const { track } = useAnalytics()
  const sentRef = useRef(false)
  const send = useEffectEvent(() => track(eventName, properties))

  useEffect(() => {
    if (sentRef.current) return
    sentRef.current = true
    send()
  }, [])
}
