import { getRequestContext } from '../../api/requestContext.js'

// Versioned key; only { productId, quantity } is stored.
// v2: product IDs are now the API's UUIDs. v3: one cart per tenant (store) and user (or guest).
const storageKey = (userId) => `basketline:cart:v3:${getRequestContext().tenantId}:${userId ?? 'guest'}`

export function loadCart(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (line) => typeof line?.productId === 'string' && Number.isInteger(line.quantity) && line.quantity > 0,
    )
  } catch {
    return []
  }
}

export function saveCart(lines, userId) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(lines.map(({ productId, quantity }) => ({ productId, quantity }))))
  } catch {
    // Private mode or quota exceeded: the cart still works for this session.
  }
}
