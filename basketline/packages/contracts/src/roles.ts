/**
 * Basketline's users are dashboard users: campaign-manager, who sees the tenant's
 * campaigns in every store. A store's shoppers aren't Basketline users: its
 * backend vouches for them (shopper tokens).
 */
export const ROLES = ['campaign-manager'] as const
export type Role = (typeof ROLES)[number]

export const CAMPAIGN_MANAGER: Role = 'campaign-manager'
