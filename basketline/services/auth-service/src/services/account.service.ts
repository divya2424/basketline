/**
 * Onboarding: creates a tenant (account) with an "onboarding" campaign manager
 * (password "test") and the tenant's first API key. The store's backend calls
 * it, keeps the key, and sends its catalog and campaigns to the retail API itself.
 * Open to anyone (see the README's warning): for demos, not production tenants.
 */
import { randomUUID } from 'node:crypto'
import { CAMPAIGN_MANAGER, type TenantDeletedPayload, type TenantOnboardedPayload, type TenantOriginsChangedPayload } from '@basketline/contracts'
import { badRequest, event, notFound, type NewEvent, type PublishEvents } from '@basketline/platform'
import { withTenant, type Db } from '../db/client.ts'
import { newApiKey } from './shopper.service.ts'
import { deleteAccountData, findAccount, insertAccount, listAccounts, updateAllowedOrigins, type Account } from '../repositories/account.repository.ts'
import type { OnboardInput } from '../validators/account.validator.ts'
import { createUser } from './user-admin.service.ts'

export const ONBOARDING_USERNAME = 'onboarding'
export const DEMO_PASSWORD = 'test'

/** The tenant's tier, for its ingestion budget. */
export function tenantOnboardedEvent(account: Account): NewEvent {
  const payload: TenantOnboardedPayload = { tenantId: account.tenantId, name: account.name, tier: account.tier }
  return event('TenantOnboarded', account.tenantId, 1, payload)
}

export function createAccountService({ db, publish }: { db: Db; publish: PublishEvents }) {
  return {
    list() {
      return listAccounts(db)
    },

    /** The account and its user are saved in one transaction; their events are published after it commits. */
    async onboard(input: OnboardInput) {
      const tenantId = randomUUID()
      const { account, users, events, apiKey } = await withTenant(db, tenantId, async (tx) => {
        const account = await insertAccount(tx, { tenantId, name: input.name.trim(), tier: input.tier })
        const created = await createUser(tx, { username: ONBOARDING_USERNAME, password: DEMO_PASSWORD, role: CAMPAIGN_MANAGER, tenantId }, null)
        const users = [{ username: created.user.username, role: created.user.role }]
        const events: NewEvent[] = created.events
        // The tenant's first API key, for its stores' backend: integration and shopper tokens.
        const apiKey = await newApiKey(tx, tenantId, 'Default')
        return { account, users, events, apiKey }
      })
      await publish([...events, tenantOnboardedEvent(account)])
      return {
        account,
        users,
        password: DEMO_PASSWORD,
        // Shown once: only its hash is kept.
        apiKey: { key: apiKey.key, prefix: apiKey.prefix, name: apiKey.name },
      }
    },

    /**
     * Deletes the tenant and everything it owns. identity_db's rows go in one
     * transaction; TenantDeleted then tells ingestion-service and the gateway
     * to delete theirs (and the archive job its
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
