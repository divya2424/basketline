import { randomUUID } from 'node:crypto'
import type { CryptoKey } from 'jose'
import {
  forbidden,
  notFound,
  signAccessToken,
  signVisitorToken,
  unauthorized,
  writeAudit,
  type AccessTokenClaims,
  type Logger,
  type PublishEvents,
} from '@ecommerce-analytics/platform'
import { withTenant, type Db } from '../db/client.ts'
import { findAccount } from '../repositories/account.repository.ts'
import { endSession, findSessionState, insertSession, listSessions } from '../repositories/session.repository.ts'
import { findUserById, findUserByUsername, setLastLogin } from '../repositories/user.repository.ts'
import type { LoginInput, RegisterInput } from '../validators/auth.validator.ts'
import { getDummyHash, verifyPassword } from './password.ts'
import { createUser, sessionRevokedEvent } from './user-admin.service.ts'

/**
 * Sign-up, sign-in and session handling. Events are published after each transaction commits.
 * Every query runs in withTenant: the storefront's tenant before sign-in, the token's tid after.
 */
export function createAuthService({ db, privateKey, publish }: { db: Db; privateKey: CryptoKey; publish: PublishEvents }) {
  async function requireAccount(tenantId: string) {
    if (!(await findAccount(db, tenantId))) throw notFound('TENANT_NOT_FOUND', 'No such tenant')
  }

  return {
    /** Always a standard-user; roles are only changed by an operator. */
    async register(input: RegisterInput, tenantId: string) {
      await requireAccount(tenantId)
      const { user, events } = await withTenant(db, tenantId, (tx) => createUser(tx, { ...input, tenantId }, null))
      await publish(events)
      return user
    },

    /** Verifies the password, records a new session and issues a 30-minute JWT. */
    /** Usernames are per tenant, so the user is looked up in the storefront's tenant. */
    async login(input: LoginInput, tenantId: string, context: { ip: string | undefined; log: Logger }) {
      const user = await withTenant(db, tenantId, (tx) => findUserByUsername(tx, tenantId, input.username))
      // Verify against a dummy hash for unknown users so timing doesn't reveal which names exist.
      const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password)
      if (!user || !valid) {
        context.log.warn({ username: input.username, ip: context.ip, reason: user ? 'bad_password' : 'unknown_user' }, 'login failed')
        throw unauthorized('INVALID_CREDENTIALS', 'Invalid username or password')
      }
      if (!user.isActive) throw forbidden('ACCOUNT_DISABLED', 'This account is disabled')

      const now = new Date()
      const sessionId = randomUUID()
      const { token, expiresAt } = await signAccessToken(privateKey, { sub: user.id, sid: sessionId, role: user.role, tid: user.tenantId }, now)
      const session = await withTenant(db, user.tenantId, async (tx) => {
        const created = await insertSession(tx, { id: sessionId, tenantId: user.tenantId, userId: user.id, clientType: input.clientType, sessionStartTime: now, expiresAt })
        await setLastLogin(tx, user.id, now)
        await writeAudit(tx, {
          actorId: user.id,
          action: 'session.started',
          subjectType: 'session',
          subjectId: sessionId,
          details: { clientType: input.clientType },
        })
        return created
      })
      context.log.info({ userId: user.id, sessionId, clientType: input.clientType }, 'login succeeded')
      return { accessToken: token, user, session }
    },

    /** Records the actual logout time and publishes SessionRevoked. */
    async logout(claims: AccessTokenClaims) {
      const { session, userVersion } = await withTenant(db, claims.tid, async (tx) => {
        const ended = await endSession(tx, claims.sid, claims.sub)
        if (!ended) throw unauthorized('SESSION_REVOKED', 'This session has already ended')
        const user = await findUserById(tx, claims.sub)
        await writeAudit(tx, { actorId: claims.sub, action: 'session.ended', subjectType: 'session', subjectId: ended.id })
        return { session: ended, userVersion: user?.version ?? 0 }
      })
      await publish([sessionRevokedEvent(session, userVersion)])
      return session
    },

    /** A token that lets an anonymous storefront visitor send analytics events for one tenant. */
    async visitor(tenantId: string) {
      await requireAccount(tenantId)
      return signVisitorToken(privateKey, tenantId)
    },

    async me(claims: AccessTokenClaims) {
      const user = await withTenant(db, claims.tid, (tx) => findUserById(tx, claims.sub))
      if (!user) throw unauthorized('INVALID_TOKEN', 'User no longer exists')
      return user
    },

    sessions(claims: AccessTokenClaims, limit: number, offset: number) {
      return withTenant(db, claims.tid, (tx) => listSessions(tx, claims.sub, limit, offset))
    },

    /**
     * This service owns the session table, so it checks it directly for its own
     * routes. Other services rely on the gateway's revocation projection.
     */
    async checkSession(claims: AccessTokenClaims) {
      const state = await withTenant(db, claims.tid, (tx) => findSessionState(tx, claims.sid, claims.sub))
      if (!state || state.sessionEndTime) throw unauthorized('SESSION_REVOKED', 'This session has ended; sign in again')
      if (!state.isActive) throw unauthorized('ACCOUNT_DISABLED', 'This account is disabled')
      if (state.role !== claims.role) throw unauthorized('TOKEN_STALE', 'Your role changed; sign in again')
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
