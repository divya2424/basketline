import { apiRequest } from '../../api/httpClient.js'

/** Basketline's account tiers. */
export const TIERS = [
  { id: 'free', label: 'Free' },
  { id: 'pro', label: 'Pro' },
  { id: 'enterprise', label: 'Enterprise' },
]

/** The retailer's stores connected to Basketline, newest first. */
export async function listStores({ signal } = {}) {
  return (await apiRequest('/stores', { signal })).items
}

/**
 * Connects a new store: the store's auth service onboards it at Basketline,
 * keeps its API key, and its catalog and campaigns are seeded and sent there.
 * Returns { store, users, password, basketlineUsers, basketlinePassword, seed }.
 */
export function connectStore({ name, tier }) {
  return apiRequest('/stores', { method: 'POST', body: { name, tier } })
}
