import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The store's own services (retailer-sim/docker-compose.yml): the storefront calls them on its
// own origin, and Basketline only through its SDK (VITE_BASKETLINE_API_URL).
const proxy = {
  '/api/v1/products': 'http://localhost:4002',
  '/api/v1/sellers': 'http://localhost:4002',
  '/api/v1/campaigns': 'http://localhost:4003',
  '/api/v1/placements': 'http://localhost:4003',
  '/api/v1/auth': 'http://localhost:4006',
  '/api/v1/stores': 'http://localhost:4006',
}

export default defineConfig({
  plugins: [react()],
  // The Basketline dashboard runs on 5173.
  server: { port: 5174, strictPort: true, proxy },
  preview: { port: 5174, strictPort: true, proxy },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    // Tests never talk to a real backend, whatever a local .env says: requests
    // to this address are answered by mockFetch (src/test/mockFetch.js).
    env: { VITE_API_BASE_URL: 'http://api.test', VITE_BASKETLINE_API_URL: 'http://basketline.test' },
  },
})
