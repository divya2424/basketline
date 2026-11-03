import { apiRequest } from '../../api/httpClient.js'
import { getRequestContext } from '../../api/requestContext.js'

/** The demo password every seeded login has (retailer-auth-service). */
export const DEMO_PASSWORD = 'test'

/**
 * Who can sign in to the current marketplace: its sellers, each with its name
 * (product-service's sellers), and its shoppers. Staff aren't listed.
 */
export async function fetchAccounts({ signal } = {}) {
  const { tenantId } = getRequestContext()
  const [{ items: logins }, { sellers }] = await Promise.all([apiRequest(`/stores/${tenantId}/logins`, { signal }), apiRequest('/sellers', { signal })])
  const names = new Map(sellers.map((seller) => [seller.sellerId, seller.name]))
  return {
    sellers: logins.filter((login) => login.role === 'seller').map((login) => ({ ...login, name: names.get(login.sellerId) ?? login.username })),
    shoppers: logins.filter((login) => login.role === 'customer'),
  }
}
