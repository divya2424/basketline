/**
 * Connecting a store to Basketline, as a retailer does: onboard it through
 * Basketline's public API (POST /accounts), keep the API key that comes back
 * (sealed), create the store's own demo logins, and announce it
 * (StoreConnected), so product- and campaign-service seed its catalog and send
 * it to Basketline with that key.
 */
import { randomUUID } from 'node:crypto'
import { type PublishEvents } from '@basketline/platform'
import { retailerEvent, sealSecret, seedPlan, type BasketlineClient, type RetailerRole } from '@retailer-sim/shared'
import type { Db } from '../db/client.ts'
import { insertStore, listStores } from '../repositories/store.repository.ts'
import { insertUser } from '../repositories/user.repository.ts'
import type { ConnectInput } from '../validators/retailer.validator.ts'
import { hashPassword } from './password.ts'

export const DEMO_PASSWORD = 'test'
export const STAFF_USERNAME = 'staff'
const CUSTOMERS = 10

export function createStoreService({ db, publish, basketline, secretsKey }: { db: Db; publish: PublishEvents; basketline: BasketlineClient; secretsKey: string }) {
  return {
    list: () => listStores(db),

    /**
     * Onboarding happens first: if saving the store fails afterwards, Basketline
     * keeps a tenant with no store here (deleted from its dashboard, if need be).
     */
    async connect(input: ConnectInput) {
      const seed = seedPlan(randomUUID())
      const onboarded = await basketline.onboard({ name: input.name.trim(), tier: input.tier })
      const sealedApiKey = sealSecret(onboarded.apiKey, secretsKey)
      const wanted: { username: string; role: RetailerRole; sellerId?: string }[] = [
        { username: STAFF_USERNAME, role: 'staff' },
        ...Array.from({ length: CUSTOMERS }, (_, i) => ({ username: `user${String(i + 1).padStart(2, '0')}`, role: 'customer' as const })),
        // A login for each seeded seller, for the seller portal.
        ...seed.sellers.map(({ sellerId }, i) => ({ username: `seller${i + 1}`, role: 'seller' as const, sellerId })),
      ]
      const hashes = await Promise.all(wanted.map(() => hashPassword(DEMO_PASSWORD)))
      const { store, users } = await db.transaction(async (tx) => {
        const store = await insertStore(tx, { tenantId: onboarded.tenantId, name: onboarded.name, tier: onboarded.tier, sealedApiKey })
        const users = []
        for (const [i, { username, role, sellerId }] of wanted.entries()) {
          users.push(await insertUser(tx, { id: randomUUID(), tenantId: store.tenantId, username, passwordHash: hashes[i]!, role, sellerId }))
        }
        return { store, users }
      })
      const staff = users[0]!
      await publish([retailerEvent('StoreConnected', store.tenantId, 1, { tenantId: store.tenantId, name: store.name, sealedApiKey, connectedBy: staff.id, seed })])
      return {
        store,
        users: users.map(({ username, role }) => ({ username, role })),
        password: DEMO_PASSWORD,
        // The store's dashboard user at Basketline (its onboarding campaign manager).
        basketlineUsers: onboarded.users,
        basketlinePassword: onboarded.password,
        seed: { products: seed.productIds.length, campaigns: seed.campaigns.length },
      }
    },
  }
}

export type StoreService = ReturnType<typeof createStoreService>
