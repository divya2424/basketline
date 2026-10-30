import type { Request, Response } from 'express'
import { ACCESS_TOKEN_TTL_SECONDS, badRequest, page, readPagination, tenantHeader, VISITOR_TOKEN_TTL_SECONDS } from '@basketline/platform'
import type { Session } from '../repositories/session.repository.ts'
import type { User } from '../repositories/user.repository.ts'
import type { AuthService } from '../services/auth.service.ts'

/** Public user shape. Never includes the password hash. */
const toPublicUser = ({ id, username, role, tenantId }: User) => ({ id, username, role, tenantId })

/** Dates become ISO strings in res.json. */
const toPublicSession = ({ id, clientType, sessionStartTime, expiresAt, sessionEndTime }: Session) => ({
  id,
  clientType,
  sessionStartTime,
  expiresAt,
  sessionEndTime,
})

/** The storefront's tenant, for requests made before the user has a token. */
function requireTenant(req: Request): string {
  const tenantId = tenantHeader(req)
  if (!tenantId) throw badRequest('TENANT_REQUIRED', 'The tenant_id header must be a UUID')
  return tenantId
}

function sessionStatus(session: Session, now: number) {
  if (session.sessionEndTime) return 'ended'
  return session.expiresAt.getTime() <= now ? 'expired' : 'active'
}

export function createAuthController(service: AuthService) {
  return {
    async register(req: Request, res: Response) {
      const user = await service.register(req.body, requireTenant(req))
      res.status(201).json({ user: toPublicUser(user) })
    },

    async visitor(req: Request, res: Response) {
      const { token, visitorId } = await service.visitor(requireTenant(req), req.body ?? {})
      res.status(201).json({ visitorToken: token, tokenType: 'Bearer', expiresIn: VISITOR_TOKEN_TTL_SECONDS, userId: visitorId })
    },

    async login(req: Request, res: Response) {
      const { accessToken, user, session } = await service.login(req.body, requireTenant(req), { ip: req.ip, log: req.log })
      res.json({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: toPublicUser(user),
        session: toPublicSession(session),
      })
    },

    async logout(req: Request, res: Response) {
      const session = await service.logout(req.auth!)
      res.json({ session: toPublicSession(session) })
    },

    async me(req: Request, res: Response) {
      const user = await service.me(req.auth!)
      res.json({
        user: { ...toPublicUser(user), isActive: user.isActive, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt },
        sessionId: req.auth!.sid,
      })
    },

    async sessions(req: Request, res: Response) {
      const { limit, offset } = readPagination(req.query)
      const { items, total } = await service.sessions(req.auth!, limit, offset)
      const now = Date.now()
      const body = items.map((session) => ({
        ...toPublicSession(session),
        status: sessionStatus(session, now),
        current: session.id === req.auth!.sid,
      }))
      res.json(page(body, total, limit, offset))
    },
  }
}

export type AuthController = ReturnType<typeof createAuthController>
