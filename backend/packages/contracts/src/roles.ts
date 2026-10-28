export const ROLES = ['standard-user', 'campaign-manager'] as const
export type Role = (typeof ROLES)[number]

export const STANDARD_USER: Role = 'standard-user'
export const CAMPAIGN_MANAGER: Role = 'campaign-manager'
