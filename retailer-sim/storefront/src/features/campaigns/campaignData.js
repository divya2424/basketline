// SAMPLE DATA, like productData.js: sent to a tenant by `pnpm seed` in basketline/
// (with these IDs as the retailer's own) and used as test fixtures.
// The marketplace's placements are its home-page sections; each campaign is one
// seller's, in one placement, with that seller's products (by ID; product records
// live in productData.js). A placement mixes several sellers' campaigns (Spotlight
// here); the same product may appear in several campaigns, and products don't have
// to belong to any (product_008 and product_009 are in none). See carouselItems.js.
export const placements = [
  { key: 'spotlight', name: 'Spotlight', position: 1, active: true },
  { key: 'top_rated', name: 'Top rated', position: 2, active: true },
  { key: 'customer_picks', name: 'Customer picks', position: 3, active: true },
  { key: 'deals', name: 'Deals', position: 4, active: true },
]

export const campaigns = [
  {
    id: 'campaign_001',
    title: 'Featured Picks',
    sellerId: 'seller_northwind',
    placement: 'spotlight',
    description: 'Our best-sellers this week.',
    productIds: ['product_001', 'product_002'],
  },
  {
    id: 'campaign_002',
    title: 'Festive Gifting',
    sellerId: 'seller_northwind',
    placement: 'top_rated',
    description: 'Gifts they will actually use.',
    productIds: ['product_004', 'product_007', 'product_002', 'product_003'],
  },
  {
    id: 'campaign_003',
    title: 'Work From Home Essentials',
    sellerId: 'seller_contoso',
    placement: 'spotlight',
    description: 'Upgrade your desk setup.',
    productIds: ['product_006', 'product_010'],
  },
  {
    id: 'campaign_004',
    title: 'Weekend Getaway',
    sellerId: 'seller_contoso',
    placement: 'deals',
    description: 'Pack light, travel far.',
    productIds: ['product_005'],
  },
]
