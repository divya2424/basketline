import { apiRequest } from '../../api/httpClient.js'

/** Products and active campaigns, read from the public catalog endpoints. */
export async function fetchCatalog({ signal } = {}) {
  const [products, campaigns] = await Promise.all([
    apiRequest('/products?limit=100', { signal }),
    apiRequest('/campaigns?status=active&limit=100', { signal }),
  ])
  return { products: products.items, campaigns: campaigns.items }
}
