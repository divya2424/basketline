import { useEffect, useState } from 'react'

/**
 * True while at least `threshold` of the element is visible in the viewport.
 * Used for impression tracking, which must be based on visibility, not on mount.
 */
export function useInView(ref, threshold = 0.5) {
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      // Very old browsers: treat as visible so impressions are not lost.
      setInView(true)
      return undefined
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio >= threshold),
      { threshold },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, threshold])

  return inView
}
