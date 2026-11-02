import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The retailer's storefront runs on 5174.
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    // Tests never talk to a real backend, whatever a local .env says: requests
    // to this address are answered by mockFetch (src/test/mockFetch.js).
    env: { VITE_API_BASE_URL: 'http://api.test', VITE_ANALYTICS_MODE: 'live' },
  },
})
