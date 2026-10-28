import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from src/db/schema.ts. No database connection needed.
export default defineConfig({ dialect: 'postgresql', schema: './src/db/schema.ts', out: './drizzle' })
