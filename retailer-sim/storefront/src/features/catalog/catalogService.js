import { apiRequest } from '../../api/httpClient.js'

/** Products, active campaigns and the marketplace's placements (its home-page sections), read from the public catalog endpoints. */
export async function fetchCatalog({ signal } = {}) {
  const [products, campaigns, placements] = await Promise.all([
    apiRequest('/products?limit=100', { signal }),
    apiRequest('/campaigns?status=active&limit=100', { signal }),
    apiRequest('/placements', { signal }),
  ])
  return { products: products.items, campaigns: campaigns.items, placements: placements.items }
}
