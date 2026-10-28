// SAMPLE DATA. The app loads the real catalog from the API; this file is the
// source for `npm run seed` in backend/ (which creates these products there)
// and the fixture for the frontend tests. Prices are numeric INR values.
export const products = [
  {
    id: 'product_001',
    name: 'Aurora Wireless Earbuds',
    description: 'True wireless earbuds with active noise cancellation and 30-hour battery life with the charging case.',
    price: 2999,
    image: '/images/aurora-earbuds.svg',
    category: 'Audio',
  },
  {
    id: 'product_002',
    name: 'Nimbus Smartwatch',
    description: 'AMOLED fitness smartwatch with heart-rate tracking, SpO2 monitoring and 7-day battery.',
    price: 5499,
    image: '/images/nimbus-smartwatch.svg',
    category: 'Wearables',
  },
  {
    id: 'product_003',
    name: 'Terra Ceramic Mug Set',
    description: 'Set of four hand-glazed stoneware mugs, 350 ml each. Microwave and dishwasher safe.',
    price: 1299,
    image: '/images/terra-mug-set.svg',
    category: 'Home & Kitchen',
  },
  {
    id: 'product_004',
    name: 'Drift Cotton Hoodie',
    description: 'Relaxed-fit hoodie in 100% brushed cotton fleece with a kangaroo pocket.',
    price: 1899,
    image: '/images/drift-hoodie.svg',
    category: 'Apparel',
  },
  {
    id: 'product_005',
    name: 'Summit 30L Travel Backpack',
    description: 'Water-resistant 30-litre backpack with a padded 15.6" laptop sleeve and luggage strap.',
    price: 2499,
    image: '/images/summit-backpack.svg',
    category: 'Bags',
  },
  {
    id: 'product_006',
    name: 'Lumen LED Desk Lamp',
    description: 'Adjustable LED desk lamp with three colour temperatures and a USB charging port.',
    price: 1599,
    image: '/images/lumen-desk-lamp.svg',
    category: 'Home Office',
  },
  {
    id: 'product_007',
    name: 'Pulse Bluetooth Speaker',
    description: 'Portable IPX7 waterproof speaker with deep bass and 12 hours of playback.',
    price: 3499,
    image: '/images/pulse-speaker.svg',
    category: 'Audio',
  },
  {
    id: 'product_008',
    name: 'Stride Running Shoes',
    description: 'Lightweight running shoes with breathable mesh upper and cushioned foam midsole.',
    price: 3999,
    image: '/images/stride-running-shoes.svg',
    category: 'Footwear',
  },
  {
    id: 'product_009',
    name: 'Verde Insulated Steel Bottle',
    description: '1-litre double-wall stainless steel bottle. Keeps drinks cold for 24 hours.',
    price: 899,
    image: '/images/verde-steel-bottle.svg',
    category: 'Fitness',
  },
  {
    id: 'product_010',
    name: 'Glide Ergonomic Wireless Mouse',
    description: 'Silent-click ergonomic mouse with 2.4 GHz and Bluetooth dual connectivity.',
    price: 1199,
    image: '/images/glide-wireless-mouse.svg',
    category: 'Home Office',
  },
]

// Built once so campaign and cart lookups are O(1).
export const productsById = new Map(products.map((product) => [product.id, product]))
