/**
 * Operator CLI (the PRD defines no admin API). Writes to identity_db, then
 * publishes the resulting events to Kafka.
 *
 *   node src/cli.ts create-account --name 'Acme Store' [--tier free|pro|enterprise] [--tenant <uuid>]
 *   node src/cli.ts seed-tenant    --tenant <uuid>   (seed products and campaigns for a tenant onboarded before seeding existed; safe to repeat)
 *   node src/cli.ts create-user --username maya --password '...' --role campaign-manager --tenant <uuid>
 *   node src/cli.ts set-role    --username maya --role standard-user --tenant <uuid>
 *   node src/cli.ts disable     --username maya --tenant <uuid>
 *
 * A tenant is an account: create it first. Usernames are unique within a
 * tenant, so every user command names the tenant.
 */
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { ROLES, TOPICS, type Role } from '@shopsphere/contracts'
import { closeDb, createBusFromEnv, createEventPublisher, createLogger, isUuid, requireEnv } from '@shopsphere/platform'
import { createAuthDb, migrateAuthDb, withTenant } from './db/client.ts'
import { accountTier } from './db/schema.ts'
import { findAccount, insertAccount } from './repositories/account.repository.ts'
import { findUserByUsername } from './repositories/user.repository.ts'
import { ONBOARDING_USERNAME, tenantOnboardedEvent } from './services/account.service.ts'
import { changeRole, createUser, disableUser, PRODUCER } from './services/user-admin.service.ts'

type Tier = (typeof accountTier.enumValues)[number]

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    username: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string' },
    tenant: { type: 'string' },
    name: { type: 'string' },
    tier: { type: 'string' },
  },
})
const [command] = positionals
const logger = createLogger('auth-cli')
const db = createAuthDb(requireEnv('DATABASE_URL'), logger)

if (command === 'create-account') {
  const tier = (values.tier ?? 'free') as Tier
  if (!accountTier.enumValues.includes(tier)) throw new Error(`--tier must be one of ${accountTier.enumValues.join(', ')}`)
  if (!values.name?.trim()) throw new Error('--name is required')
  if (values.tenant !== undefined && !isUuid(values.tenant)) throw new Error('--tenant must be a UUID (leave it out to generate one)')
  try {
    await migrateAuthDb(db)
    const account = await insertAccount(db, { tenantId: values.tenant?.toLowerCase() ?? randomUUID(), name: values.name.trim(), tier })
    console.log(JSON.stringify(account))
  } finally {
    await closeDb(db)
  }
} else if (command === 'seed-tenant') {
  if (!isUuid(values.tenant)) throw new Error('--tenant must be the UUID of the tenant (account) to seed')
  const tenantId = values.tenant.toLowerCase()
  const bus = await createBusFromEnv('auth-cli', logger, [TOPICS.tenants])
  try {
    await migrateAuthDb(db)
    const account = await findAccount(db, tenantId)
    if (!account) throw new Error(`No account for tenant ${tenantId}`)
    const onboarding = await withTenant(db, tenantId, (tx) => findUserByUsername(tx, tenantId, ONBOARDING_USERNAME))
    if (!onboarding) throw new Error(`Tenant ${tenantId} has no "${ONBOARDING_USERNAME}" user to own the seeded data`)
    const seed = tenantOnboardedEvent(account, onboarding.id)
    await createEventPublisher(bus, PRODUCER, logger, { failOnError: true })([seed])
    console.log(JSON.stringify({ tenantId, name: account.name, seeded: seed.payload }))
  } finally {
    await bus.close()
    await closeDb(db)
  }
} else {
  const role = values.role as Role | undefined
  const username = values.username
  if (role !== undefined && !ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`)
  if (!username) throw new Error('--username is required')
  if (!isUuid(values.tenant)) throw new Error('--tenant must be the UUID of the tenant (account) the user belongs to')
  const tenantId = values.tenant.toLowerCase()

  const bus = await createBusFromEnv('auth-cli', logger, [TOPICS.users, TOPICS.sessions])
  try {
    await migrateAuthDb(db)
    if (!(await findAccount(db, tenantId))) throw new Error(`No account for tenant ${tenantId}; run create-account first`)
    const { user, events } = await withTenant(db, tenantId, async (tx) => {
      switch (command) {
        case 'create-user':
          if (!values.password) throw new Error('--password is required')
          return createUser(tx, { username, password: values.password, role, tenantId }, null)
        case 'set-role':
          if (!role) throw new Error('--role is required')
          return changeRole(tx, tenantId, username, role, null)
        case 'disable':
          return disableUser(tx, tenantId, username, null)
        default:
          throw new Error('Usage: cli.ts <create-account|seed-tenant|create-user|set-role|disable> … (see the top of src/cli.ts)')
      }
    })
    await createEventPublisher(bus, PRODUCER, logger)(events)
    console.log(JSON.stringify({ id: user.id, username: user.username, role: user.role, tenantId: user.tenantId, isActive: user.isActive }))
  } finally {
    await bus.close()
    await closeDb(db)
  }
}
