import { forbidden, unauthorized, type AccessTokenClaims, type Logger } from '@basketline/platform'
import type { Db } from '../db/client.ts'
import { deleteExpiredRevocations, findTenantOrigins, findUserAccessState, isSessionRevoked, isTenantDeleted } from '../repositories/access.repository.ts'

export function createAccessService({ db, logger }: { db: Db; logger: Logger }) {
  return {
    /**
     * Rejects tokens whose session was revoked, whose account is disabled, or
     * that were issued before a role change. Based on the local projection,
     * so it reflects auth-service changes within a few seconds (eventual consistency).
     */
    async assertTokenUsable(claims: AccessTokenClaims): Promise<void> {
      const [revoked, state, deleted] = await Promise.all([isSessionRevoked(db, claims.sid), findUserAccessState(db, claims.sub), isTenantDeleted(db, claims.tid)])
      if (deleted) throw unauthorized('TENANT_DELETED', 'This tenant has been deleted')
      if (revoked) throw unauthorized('SESSION_REVOKED', 'This session has ended; sign in again')
      if (state?.disabled) throw unauthorized('ACCOUNT_DISABLED', 'This account is disabled')
      if (state?.tokensNotBefore && claims.iat * 1000 < state.tokensNotBefore.getTime()) {
        throw unauthorized('TOKEN_STALE', 'Your role changed; sign in again')
      }
    },

    /** Events-only tokens (visitors', shoppers') have no session; only their tenant can make them unusable. */
    async assertTenantActive(tenantId: string): Promise<void> {
      if (await isTenantDeleted(db, tenantId)) throw unauthorized('TENANT_DELETED', 'This tenant has been deleted')
    },

    /** A browser page may send a tenant's events only from one of its allowed websites, if it lists any. */
    async assertOriginAllowed(tenantId: string, origin: string): Promise<void> {
      const origins = await findTenantOrigins(db, tenantId)
      if (origins.length > 0 && !origins.includes(origin)) {
        throw forbidden('ORIGIN_NOT_ALLOWED', `${origin} isn't one of this store's allowed websites`)
      }
    },

    async cleanup(): Promise<void> {
      const removed = await deleteExpiredRevocations(db)
      if (removed > 0) logger.info({ removed }, 'removed expired session revocations')
    },
  }
}

export type AccessService = ReturnType<typeof createAccessService>
