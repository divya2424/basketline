/**
 * Basketline's users are dashboard users: campaign-manager, the retailer's admin
 * (every seller); seller-manager, one seller's own campaigns. A retailer's
 * shoppers aren't Basketline users: its backend vouches for them (shopper tokens).
 */
export const ROLES = ['campaign-manager', 'seller-manager'] as const
export type Role = (typeof ROLES)[number]

export const CAMPAIGN_MANAGER: Role = 'campaign-manager'
export const SELLER_MANAGER: Role = 'seller-manager'
