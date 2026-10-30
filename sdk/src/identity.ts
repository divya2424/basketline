import { isUuid } from './events'

/** The bits of Web Storage the SDK uses (localStorage by default). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** IDs for stores whose ID can't be kept (storage blocked, e.g. private mode): kept for this page. */
const pageIds = new Map<string, string>()

/**
 * This browser's lasting visitor UUID for one store (tenant): its events' userId
 * while not signed in, so a visitor counts as one customer across visits. One
 * per store, so stores can't link a shopper. The key is the storefront's own
 * (basketline:anonymous-id:<tenant>), so its visitors keep their IDs.
 */
export function visitorIdFor(tenantId: string, storage: KeyValueStorage | undefined, newId: () => string): string {
  const key = `basketline:anonymous-id:${tenantId}`
  try {
    if (!storage) throw new Error('no storage')
    const stored = storage.getItem(key)
    if (isUuid(stored)) return stored
    const id = newId()
    storage.setItem(key, id)
    return id
  } catch {
    if (!pageIds.has(tenantId)) pageIds.set(tenantId, newId())
    return pageIds.get(tenantId)!
  }
}

/** A JWT's expiry (exp claim) in ms, or null if it can't be read; the SDK only reads it, the API verifies it. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json.exp === 'number' ? json.exp * 1000 : null
  } catch {
    return null
  }
}
