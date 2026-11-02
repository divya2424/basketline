import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['services/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test' },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
