// GET /ad/campaigns as test fixtures: one item per campaign and store with activity.
export const WEB_STORE = '5e1a0b6c-0000-5000-8000-000000000001'
export const APP_STORE = '5e1a0b6c-0000-5000-8000-000000000002'
export const NO_STORE = '00000000-0000-0000-0000-000000000000'

export const campaigns = [
  { id: 'campaign_001', storeId: WEB_STORE, lastDay: '2026-10-30' },
  { id: 'campaign_002', storeId: WEB_STORE, lastDay: '2026-10-30' },
  { id: 'campaign_002', storeId: APP_STORE, lastDay: '2026-10-29' },
  { id: 'campaign_003', storeId: APP_STORE, lastDay: '2026-10-28' },
  { id: 'campaign_004', storeId: NO_STORE, lastDay: '2026-10-20' },
]
