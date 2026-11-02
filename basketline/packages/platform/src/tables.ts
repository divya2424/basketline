/**
 * Tables that several services need. Each service re-exports the ones it uses
 * from its src/db/schema.ts, so drizzle-kit includes them in its migrations.
 */
import { bigserial, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { Database, Transaction } from './db.ts'

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** Kafka events this service has already applied (so redeliveries are ignored). */
export const processedEvents = pgTable('processed_events', {
  eventId: uuid('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  processedAt: timestamptz('processed_at').notNull().defaultNow(),
})

/** Who changed what (PRD §8: audit logs for users, campaigns and role changes). */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  details: jsonb('details').notNull().default({}),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
})

export async function writeAudit(
  db: Database<any> | Transaction<Database<any>>,
  entry: { actorId: string | null; action: string; subjectType: string; subjectId: string; details?: object },
): Promise<void> {
  await db.insert(auditLog).values({ ...entry, details: entry.details ?? {} })
}
