/**
 * Demo onboarding: creates a tenant (account) with an "onboarding" campaign
 * manager and, optionally, ten standard users, all with the password "test".
 * TenantOnboarded then has product-service and campaign-service seed the
 * tenant with 10–15 products and 2 active campaigns (of 2 and 3 of them).
 * Open to anyone (see the README's warning): for demos, not production tenants.
 */
import { createHash, randomUUID } from 'node:crypto'
import { CAMPAIGN_MANAGER, SELLER_MANAGER, STANDARD_USER, type Role, type TenantDeletedPayload, type TenantOnboardedPayload, type TenantOriginsChangedPayload } from '@basketline/contracts'
import { badRequest, event, notFound, type NewEvent, type PublishEvents } from '@basketline/platform'
import { withTenant, type Db } from '../db/client.ts'
import { newApiKey } from './shopper.service.ts'
import { deleteAccountData, findAccount, insertAccount, listAccounts, updateAllowedOrigins, type Account } from '../repositories/account.repository.ts'
import type { OnboardInput } from '../validators/account.validator.ts'
import { createUser } from './user-admin.service.ts'

export const ONBOARDING_USERNAME = 'onboarding'
export const DEMO_PASSWORD = 'test'
const DUMMY_USERS = 10
const SEED_PRODUCTS = { min: 10, max: 15 }
const SEED_CAMPAIGN_SIZES = [2, 3]
const SEED_SELLERS = ['Northwind Traders', 'Contoso Goods']

// The seed plan is drawn from the tenant ID (itself random): it differs from tenant
// to tenant, but is the same every time for one tenant, so sending a tenant's
// TenantOnboarded again (cli.ts seed-tenant) creates nothing twice.
const digest = (tenantId: string, label: string) => createHash('sha256').update(`${tenantId}:${label}`).digest()
const numberBelow = (tenantId: string, label: string, below: number) => digest(tenantId, label).readUInt32BE(0) % below

function uuidFrom(tenantId: string, label: string): string {
  const bytes = digest(tenantId, label).subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4 layout
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 10–15 product IDs, and campaigns of 2 and 3 distinct ones among them. */
export function seedPlan(tenantId: string): TenantOnboardedPayload['seed'] {
  const count = SEED_PRODUCTS.min + numberBelow(tenantId, 'product-count', SEED_PRODUCTS.max - SEED_PRODUCTS.min + 1)
  const productIds = Array.from({ length: count }, (_, i) => uuidFrom(tenantId, `product:${i}`))
  // Fisher–Yates shuffle, then consecutive slices: no product is in both campaigns.
  const shuffled = [...productIds]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = numberBelow(tenantId, `shuffle:${i}`, i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  // Two sellers: campaign i is seller i % 2's, with its products; the rest alternate.
  const sellers = SEED_SELLERS.map((name, i) => ({ sellerId: uuidFrom(tenantId, `seller:${i}`), name, productIds: [] as string[] }))
  let next = 0
  const campaigns = SEED_CAMPAIGN_SIZES.map((size, i) => {
    const seller = sellers[i % sellers.length]!
    const campaignProducts = shuffled.slice(next, (next += size))
    seller.productIds.push(...campaignProducts)
    return { campaignId: uuidFrom(tenantId, `campaign:${i}`), sellerId: seller.sellerId, productIds: campaignProducts }
  })
  shuffled.slice(next).forEach((productId, i) => sellers[i % sellers.length]!.productIds.push(productId))
  return { productIds, sellers, campaigns }
}

/** The event that has product-service and campaign-service seed the tenant. */
export function tenantOnboardedEvent(account: Account, onboardedBy: string): NewEvent {
  const payload: TenantOnboardedPayload = { tenantId: account.tenantId, name: account.name, tier: account.tier, onboardedBy, seed: seedPlan(account.tenantId) }
  return event('TenantOnboarded', account.tenantId, 1, payload)
}

export function createAccountService({ db, publish }: { db: Db; publish: PublishEvents }) {
  return {
    list() {
      return listAccounts(db)
    },

    /** The account and its users are saved in one transaction; their events are published after it commits. */
    async onboard(input: OnboardInput) {
      const tenantId = randomUUID()
      const { account, users, events, apiKey } = await withTenant(db, tenantId, async (tx) => {
        const account = await insertAccount(tx, { tenantId, name: input.name.trim(), tier: input.tier })
        const firstSeller = seedPlan(tenantId).sellers[0]!.sellerId
        const wanted: { username: string; role: Role; sellerId?: string }[] = [
          { username: ONBOARDING_USERNAME, role: CAMPAIGN_MANAGER },
          ...(input.dummyUsers
            ? [
                ...Array.from({ length: DUMMY_USERS }, (_, i) => ({ username: `user${String(i + 1).padStart(2, '0')}`, role: STANDARD_USER })),
                // The first seeded seller's manager: sees only that seller's campaigns.
                { username: 'seller01', role: SELLER_MANAGER, sellerId: firstSeller },
              ]
            : []),
        ]
        const users = []
        const events: NewEvent[] = []
        for (const { username, role, sellerId } of wanted) {
          const created = await createUser(tx, { username, password: DEMO_PASSWORD, role, tenantId, sellerId }, null)
          users.push({ id: created.user.id, username: created.user.username, role: created.user.role })
          events.push(...created.events)
        }
        // The vendor's first API key, for its backend to identify signed-in shoppers (POST /auth/shopper-token).
        const apiKey = await newApiKey(tx, tenantId, 'Default')
        return { account, users, events, apiKey }
      })
      const onboarded = tenantOnboardedEvent(account, users[0]!.id)
      await publish([...events, onboarded])
      const { seed } = onboarded.payload as TenantOnboardedPayload
      return {
        account,
        users: users.map(({ username, role }) => ({ username, role })),
        password: DEMO_PASSWORD,
        // Shown once: only its hash is kept.
        apiKey: { key: apiKey.key, prefix: apiKey.prefix, name: apiKey.name },
        seed: { products: seed.productIds.length, campaigns: seed.campaigns.length },
      }
    },

    /**
     * Deletes the tenant and everything it owns. identity_db's rows go in one
     * transaction; TenantDeleted then tells product-, campaign- and
     * analytics-service and the gateway to delete theirs (and the archive job its
     * files). The name must be typed again (confirmName), so a slip can't delete
     * the wrong tenant.
     */
    async deleteTenant(tenantId: string, confirmName: string) {
      const account = await findAccount(db, tenantId)
      if (!account) throw notFound('TENANT_NOT_FOUND', 'No such tenant')
      if (confirmName.trim() !== account.name) throw badRequest('CONFIRMATION_MISMATCH', "confirmName doesn't match the tenant's name")
      await withTenant(db, tenantId, (tx) => deleteAccountData(tx, tenantId))
      const payload: TenantDeletedPayload = { tenantId, name: account.name, deletedAt: new Date().toISOString() }
      // Version 2: after TenantOnboarded (1).
      await publish([event('TenantDeleted', tenantId, 2, payload)])
      return payload
    },

    async allowedOrigins(tenantId: string): Promise<string[]> {
      const account = await findAccount(db, tenantId)
      if (!account) throw notFound('TENANT_NOT_FOUND', 'No such tenant')
      return account.allowedOrigins
    },

    /**
     * Replaces the websites whose pages may send the tenant's events (empty: any);
     * the gateway enforces them once TenantOriginsChanged reaches it. Origins are
     * normalized ("HTTPS://Shop.example:443/" → "https://shop.example") and deduplicated.
     */
    async setAllowedOrigins(tenantId: string, origins: string[]): Promise<string[]> {
      const normalized = [...new Set(origins.map((origin) => new URL(origin).origin))]
      const updated = await updateAllowedOrigins(db, tenantId, normalized)
      if (!updated) throw notFound('TENANT_NOT_FOUND', 'No such tenant')
      const payload: TenantOriginsChangedPayload = { tenantId, origins: updated.origins, version: updated.version, changedAt: updated.changedAt.toISOString() }
      await publish([event('TenantOriginsChanged', tenantId, updated.version, payload)])
      return updated.origins
    },
  }
}

export type AccountService = ReturnType<typeof createAccountService>
