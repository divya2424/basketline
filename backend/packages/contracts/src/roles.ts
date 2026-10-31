/** campaign-manager: the retailer's admin, every seller; seller-manager: one seller's own campaigns and products. */
export const ROLES = ['standard-user', 'campaign-manager', 'seller-manager'] as const
export type Role = (typeof ROLES)[number]

export const STANDARD_USER: Role = 'standard-user'
export const CAMPAIGN_MANAGER: Role = 'campaign-manager'
export const SELLER_MANAGER: Role = 'seller-manager'
