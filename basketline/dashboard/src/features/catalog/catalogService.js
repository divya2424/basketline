import { apiRequest } from '../../api/httpClient.js'

/** The tenant's campaigns to report on ({ id, title, sellerId, status }), as Basketline knows them from the retailer's campaign events. */
export async function fetchCatalog({ signal } = {}) {
  const { items } = await apiRequest('/ad/campaigns', { signal })
  return { campaigns: items }
}
