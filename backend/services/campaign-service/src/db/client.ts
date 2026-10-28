import path from 'node:path'
import { createDb, runMigrations, type Database, type Logger, type Transaction } from '@ecommerce-analytics/platform'
import * as schema from './schema.ts'

export const createCampaignDb = (url: string, logger?: Logger) => createDb(url, schema, logger)
export const migrateCampaignDb = (db: Db) => runMigrations(db, path.join(import.meta.dirname, '../../drizzle'))

export type Db = Database<typeof schema>
export type DbOrTx = Db | Transaction<Db>
