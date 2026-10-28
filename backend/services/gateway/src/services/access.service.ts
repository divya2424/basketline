import { unauthorized, type AccessTokenClaims, type Logger } from '@shopsphere/platform'
import type { Db } from '../db/client.ts'
import { deleteExpiredRevocations, findUserAccessState, isSessionRevoked } from '../repositories/access.repository.ts'

export function createAccessService({ db, logger }: { db: Db; logger: Logger }) {
  return {
    /**
     * Rejects tokens whose session was revoked, whose account is disabled, or
     * that were issued before a role change. Based on the local projection,
     * so it reflects auth-service changes within a few seconds (eventual consistency).
     */
    async assertTokenUsable(claims: AccessTokenClaims): Promise<void> {
      const [revoked, state] = await Promise.all([isSessionRevoked(db, claims.sid), findUserAccessState(db, claims.sub)])
      if (revoked) throw unauthorized('SESSION_REVOKED', 'This session has ended; sign in again')
      if (state?.disabled) throw unauthorized('ACCOUNT_DISABLED', 'This account is disabled')
      if (state?.tokensNotBefore && claims.iat * 1000 < state.tokensNotBefore.getTime()) {
        throw unauthorized('TOKEN_STALE', 'Your role changed; sign in again')
      }
    },

    async cleanup(): Promise<void> {
      const removed = await deleteExpiredRevocations(db)
      if (removed > 0) logger.info({ removed }, 'removed expired session revocations')
    },
  }
}

export type AccessService = ReturnType<typeof createAccessService>
