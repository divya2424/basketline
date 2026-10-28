/**
 * Remembers the latest campaign ad click per product (sessionStorage), so a
 * later add-to-cart can be credited to it. Each click is credited once.
 */
const KEY = 'shopsphere:ad-clicks:v1'
export const ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000

function read() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

function write(clicks) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(clicks))
  } catch {
    // Storage unavailable: attribution only works within this page view.
  }
}

export function createAttributionStore() {
  let memory = read()
  return {
    recordClick({ clickId, campaignId, productId, at }) {
      memory = { ...memory, [productId]: { clickId, campaignId, at } }
      write(memory)
    },
    /** The unused click for this product within the window, marking it used; or null. */
    takeClick(productId, at) {
      const click = memory[productId]
      if (!click || Date.parse(at) - Date.parse(click.at) > ATTRIBUTION_WINDOW_MS) return null
      const { [productId]: _used, ...rest } = memory
      memory = rest
      write(memory)
      return click
    },
  }
}
