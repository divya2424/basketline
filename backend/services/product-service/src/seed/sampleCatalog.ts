/**
 * Demo products an onboarded tenant is seeded with (see events/tenant.consumer.ts).
 * The first ten match the storefront's sample data (frontend/src/features/products/
 * productData.js), whose images the frontend serves; the others have no image.
 */
export interface SampleProduct {
  name: string
  description: string
  price: number
  image: string | null
  category: string
}

export const SAMPLE_CATALOG: SampleProduct[] = [
  { name: 'Aurora Wireless Earbuds', description: 'True wireless earbuds with active noise cancellation and 30-hour battery life with the charging case.', price: 2999, image: '/images/aurora-earbuds.svg', category: 'Audio' },
  { name: 'Nimbus Smartwatch', description: 'AMOLED fitness smartwatch with heart-rate tracking, SpO2 monitoring and 7-day battery.', price: 5499, image: '/images/nimbus-smartwatch.svg', category: 'Wearables' },
  { name: 'Terra Ceramic Mug Set', description: 'Set of four hand-glazed stoneware mugs, 350 ml each. Microwave and dishwasher safe.', price: 1299, image: '/images/terra-mug-set.svg', category: 'Home & Kitchen' },
  { name: 'Drift Cotton Hoodie', description: 'Relaxed-fit hoodie in 100% brushed cotton fleece with a kangaroo pocket.', price: 1899, image: '/images/drift-hoodie.svg', category: 'Apparel' },
  { name: 'Summit 30L Travel Backpack', description: 'Water-resistant 30-litre backpack with a padded 15.6" laptop sleeve and luggage strap.', price: 2499, image: '/images/summit-backpack.svg', category: 'Bags' },
  { name: 'Lumen LED Desk Lamp', description: 'Adjustable LED desk lamp with three colour temperatures and a USB charging port.', price: 1599, image: '/images/lumen-desk-lamp.svg', category: 'Home Office' },
  { name: 'Pulse Bluetooth Speaker', description: 'Portable IPX7 waterproof speaker with deep bass and 12 hours of playback.', price: 3499, image: '/images/pulse-speaker.svg', category: 'Audio' },
  { name: 'Stride Running Shoes', description: 'Lightweight running shoes with breathable mesh upper and cushioned foam midsole.', price: 3999, image: '/images/stride-running-shoes.svg', category: 'Footwear' },
  { name: 'Verde Insulated Steel Bottle', description: '1-litre double-wall stainless steel bottle. Keeps drinks cold for 24 hours.', price: 899, image: '/images/verde-steel-bottle.svg', category: 'Fitness' },
  { name: 'Glide Ergonomic Wireless Mouse', description: 'Silent-click ergonomic mouse with 2.4 GHz and Bluetooth dual connectivity.', price: 1199, image: '/images/glide-wireless-mouse.svg', category: 'Home Office' },
  { name: 'Halo Yoga Mat', description: '6 mm non-slip TPE yoga mat with alignment lines and a carry strap.', price: 1499, image: null, category: 'Fitness' },
  { name: 'Ember Cast-Iron Skillet', description: 'Pre-seasoned 26 cm cast-iron skillet for stovetop, oven and grill.', price: 1799, image: null, category: 'Home & Kitchen' },
  { name: 'Orbit USB-C Charging Hub', description: '65 W charging hub with two USB-C and two USB-A ports.', price: 2299, image: null, category: 'Home Office' },
  { name: 'Coast Linen Shirt', description: 'Breathable pure-linen shirt with a relaxed fit and mother-of-pearl buttons.', price: 2199, image: null, category: 'Apparel' },
  { name: 'Trail Hiking Socks (3 pairs)', description: 'Merino-blend cushioned hiking socks with arch support.', price: 799, image: null, category: 'Footwear' },
]
