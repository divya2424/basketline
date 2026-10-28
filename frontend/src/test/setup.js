import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { installIntersectionObserver } from './intersectionObserver.js'
import { localCollector, setTransport } from '../analytics/analytics.js'
import { setRequestTenant, setRequestUser } from '../api/requestContext.js'

// jsdom doesn't implement scrolling. Like newer Chrome, return a Promise, so an effect
// that returns scrollTo's result (React takes it for a cleanup) fails in tests too.
window.scrollTo = () => Promise.resolve()

beforeEach(() => {
  installIntersectionObserver()
  localStorage.clear()
  sessionStorage.clear()
  localCollector.clear()
  setTransport(localCollector)
  setRequestUser(null)
  setRequestTenant(null)
})

afterEach(() => {
  cleanup()
})
