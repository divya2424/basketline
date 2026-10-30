/**
 * Account administration: creating users, changing roles, disabling accounts.
 * Each function runs inside the caller's transaction and returns the events
 * to publish once that transaction has committed.
 */
import { randomUUID } from 'node:crypto'
import { STANDARD_USER, type Role } from '@basketline/contracts'
import { conflict, event, isUniqueViolation, notFound, writeAudit, type NewEvent } from '@basketline/platform'
import type { DbOrTx } from '../db/client.ts'
import { endOpenSessionsForUser, type Session } from '../repositories/session.repository.ts'
import { deactivateUser, findUserByUsername, insertUser, updateUserRole, type User } from '../repositories/user.repository.ts'
import { hashPassword } from './password.ts'

export const PRODUCER = 'auth-service'

export interface AdminResult {
  user: User
  events: NewEvent[]
}

async function requireUserForUpdate(db: DbOrTx, tenantId: string, username: string): Promise<User> {
  const user = await findUserByUsername(db, tenantId, username, { forUpdate: true })
  if (!user) throw notFound('USER_NOT_FOUND', `No user named ${username}`)
  return user
}

export async function createUser(
  db: DbOrTx,
  // id: a given user ID (a visitor's UUID at sign-up), else a random one.
  input: { username: string; password: string; role?: Role; tenantId: string; id?: string },
  actorId: string | null,
): Promise<AdminResult> {
  const role = input.role ?? STANDARD_USER
  let user: User
  try {
    user = await insertUser(db, {
      id: input.id ?? randomUUID(),
      username: input.username.trim(),
      passwordHash: await hashPassword(input.password),
      role,
      tenantId: input.tenantId,
    })
  } catch (error) {
    if (isUniqueViolation(error, 'users_username_unique')) throw conflict('USERNAME_TAKEN', 'That username is already registered')
    throw error
  }
  await writeAudit(db, { actorId: actorId ?? user.id, action: 'user.created', subjectType: 'user', subjectId: user.id, details: { role, tenantId: input.tenantId } })
  return {
    user,
    events: [event('UserCreated', user.id, user.version, { userId: user.id, username: user.username, role: user.role, isActive: user.isActive })],
  }
}

export async function changeRole(db: DbOrTx, tenantId: string, username: string, role: Role, actorId: string | null): Promise<AdminResult> {
  const current = await requireUserForUpdate(db, tenantId, username)
  if (current.role === role) return { user: current, events: [] }
  const user = await updateUserRole(db, current.id, role)
  await writeAudit(db, { actorId, action: 'user.role_changed', subjectType: 'user', subjectId: user.id, details: { from: current.role, to: role } })
  return {
    user,
    events: [
      event('UserRoleChanged', user.id, user.version, {
        userId: user.id,
        role,
        previousRole: current.role,
        changedAt: user.updatedAt.toISOString(),
      }),
    ],
  }
}

/** Disables the account and ends all of its open sessions. */
export async function disableUser(db: DbOrTx, tenantId: string, username: string, actorId: string | null): Promise<AdminResult> {
  const current = await requireUserForUpdate(db, tenantId, username)
  if (!current.isActive) return { user: current, events: [] }
  const user = await deactivateUser(db, current.id)
  const ended = await endOpenSessionsForUser(db, user.id)
  await writeAudit(db, { actorId, action: 'user.disabled', subjectType: 'user', subjectId: user.id, details: { endedSessions: ended.length } })
  return {
    user,
    events: [
      event('UserDisabled', user.id, user.version, { userId: user.id, disabledAt: user.updatedAt.toISOString() }),
      ...ended.map((session) => sessionRevokedEvent(session, user.version)),
    ],
  }
}

/** Keyed by user so a user's session events stay ordered on one partition. */
export function sessionRevokedEvent(session: Session, userVersion: number): NewEvent {
  return event('SessionRevoked', session.userId, userVersion, {
    sessionId: session.id,
    userId: session.userId,
    revokedAt: (session.sessionEndTime ?? new Date()).toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  })
}
