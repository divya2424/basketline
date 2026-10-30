import { defineConfig } from 'tsup'

// ESM and CommonJS for bundlers and Node, and one script-tag build that sets
// window.Basketline. Type declarations come from tsc (see package.json).
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm', 'cjs'], target: 'es2020', clean: true, sourcemap: true, dts: false },
  {
    entry: { basketline: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Basketline',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    outExtension: () => ({ js: '.global.js' }),
  },
])
