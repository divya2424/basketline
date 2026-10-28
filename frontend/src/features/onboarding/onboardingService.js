/**
 * Tenant onboarding API (auth-service, through the gateway; no sign-in needed).
 * Every onboarded tenant gets an "onboarding" campaign manager and, if asked,
 * ten standard users user01–user10, all with the password "test".
 */
import { apiRequest } from '../../api/httpClient.js'

export const ONBOARDING_USERNAME = 'onboarding'
export const DEMO_PASSWORD = 'test'

export const TIERS = [
  { id: 'free', label: 'Free' },
  { id: 'pro', label: 'Pro' },
  { id: 'enterprise', label: 'Enterprise' },
]

/** [{ tenantId, name, tier, createdAt }], newest first. */
export async function listAccounts({ signal } = {}) {
  return (await apiRequest('/accounts', { signal })).items
}

/** The server generates the tenant ID. Resolves with { account, users: [{ username, role }], password }. */
export function onboardTenant({ name, tier, dummyUsers }) {
  return apiRequest('/accounts', { method: 'POST', body: { name, tier, dummyUsers } })
}
