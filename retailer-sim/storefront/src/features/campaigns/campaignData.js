// SAMPLE DATA, like productData.js: seeded into the backend by `npm run seed`
// (product_00x IDs are matched by product name) and used as test fixtures.
// Campaigns reference products by ID only; product records live in productData.js.
// A campaign can feature any number of products, the same product may appear in
// several campaigns, and products don't have to belong to any campaign
// (product_008 and product_009 are in none). The carousel mixes products from
// all campaigns; see carouselItems.js.
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
