import { apiRequest } from '../../api/httpClient.js'

/** The tenant's campaigns to report on: one { id, storeId, lastDay } per campaign and store with activity, newest first. */
export async function fetchCatalog({ signal } = {}) {
  const { items } = await apiRequest('/ad/campaigns', { signal })
  return { campaigns: items }
}
