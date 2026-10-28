import { createContext, useCallback, useContext, useMemo } from 'react'
import { trackEvent } from '../../analytics/analytics.js'

const AnalyticsContext = createContext({ featureName: 'app', pageName: 'unknown', eventName: null, properties: {} })

/**
 * Supplies analytics context (feature, page, default event and shared
 * properties) to everything inside it. It does not detect interactions on its
 * own: components call `track()` from useAnalytics() in their event handlers.
 * Nested wrappers inherit and extend the outer context.
 */
export function AnalyticsWrapper({ featureName, pageName, eventName, properties, children }) {
  const parent = useContext(AnalyticsContext)
  // Callers often pass `properties` as an inline object; key the memo on its
  // contents so consumers don't re-render when the values haven't changed.
  const propertiesKey = JSON.stringify(properties ?? {})
  const value = useMemo(
    () => ({
      featureName: featureName ?? parent.featureName,
      pageName: pageName ?? parent.pageName,
      eventName: eventName ?? parent.eventName,
      properties: { ...parent.properties, ...JSON.parse(propertiesKey) },
    }),
    [featureName, pageName, eventName, propertiesKey, parent],
  )
  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
}

/** Returns `track(eventName?, properties?)` bound to the nearest wrapper's context. */
export function useAnalytics() {
  const context = useContext(AnalyticsContext)
  const track = useCallback(
    (eventName, properties) =>
      trackEvent({
        featureName: context.featureName,
        pageName: context.pageName,
        eventName: eventName ?? context.eventName,
        properties: { ...context.properties, ...properties },
      }),
    [context],
  )
  return { track, featureName: context.featureName, pageName: context.pageName }
}
