// A copy of the storefront's sample campaigns (retailer-sim/storefront), as test fixtures.
export const campaigns = [
  {
    id: 'campaign_001',
    title: 'Featured Picks',
    type: 'product_collection',
    description: 'Our best-sellers this week.',
    productIds: ['product_001', 'product_002'],
  },
  {
    id: 'campaign_002',
    title: 'Festive Gifting',
    type: 'product_collection',
    description: 'Gifts they will actually use.',
    productIds: ['product_004', 'product_007', 'product_002', 'product_003'],
  },
  {
    id: 'campaign_003',
    title: 'Work From Home Essentials',
    type: 'product_collection',
    description: 'Upgrade your desk setup.',
    productIds: ['product_006', 'product_010'],
  },
  {
    id: 'campaign_004',
    title: 'Weekend Getaway',
    type: 'product_collection',
    description: 'Pack light, travel far.',
    productIds: ['product_005'],
  },
]
