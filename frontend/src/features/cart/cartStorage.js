import { getRequestContext } from '../../api/requestContext.js'

// Versioned key; only { productId, quantity } is stored.
// v2: product IDs are now the API's UUIDs. One cart per tenant (store).
const storageKey = () => `shopsphere:cart:v2:${getRequestContext().tenantId}`

export function loadCart() {
  try {
    const raw = localStorage.getItem(storageKey())
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (line) => typeof line?.productId === 'string' && Number.isInteger(line.quantity) && line.quantity > 0,
    )
  } catch {
    return []
  }
}

export function saveCart(lines) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(lines.map(({ productId, quantity }) => ({ productId, quantity }))))
  } catch {
    // Private mode or quota exceeded: the cart still works for this session.
  }
}
