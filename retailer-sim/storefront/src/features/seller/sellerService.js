/**
 * The seller portal's calls to the marketplace's campaign service (the retailer's,
 * not Basketline's): a seller's own campaigns, and their results, which the
 * campaign service reads from Basketline with the store's API key.
 */
import { apiRequest } from '../../api/httpClient.js'

/** The marketplace's active placements (its home-page sections), in order. */
export async function listPlacements({ signal } = {}) {
  return (await apiRequest('/placements', { signal })).items
}

/** The seller's campaigns, newest first. */
export async function listMyCampaigns(sellerId, { signal } = {}) {
  return (await apiRequest(`/campaigns?sellerId=${encodeURIComponent(sellerId)}&limit=100`, { signal })).items
}

/** { title, placement, status, productIds }: the campaign is the signed-in seller's. */
export function createCampaign(input) {
  return apiRequest('/campaigns', { method: 'POST', body: input })
}

export function setCampaignStatus(campaignId, status) {
  return apiRequest(`/campaigns/${campaignId}`, { method: 'PATCH', body: { status } })
}

export function addCampaignProducts(campaignId, productIds) {
  return apiRequest(`/campaigns/${campaignId}/products`, { method: 'POST', body: { productIds } })
}

export function removeCampaignProduct(campaignId, productId) {
  return apiRequest(`/campaigns/${campaignId}/products/${productId}`, { method: 'DELETE' })
}

/** The campaign's results per product over the last `days` days: { items: [{ productId, name, impressions, clicks, ctr, addToCarts, clickToBasket }] }. */
export function fetchResults(campaignId, { days = 30, signal } = {}) {
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return apiRequest(`/campaigns/${campaignId}/results?from=${encodeURIComponent(from)}`, { signal })
}
