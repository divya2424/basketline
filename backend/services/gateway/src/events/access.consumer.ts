import type { EventEnvelope, EventPayloads } from '@shopsphere/contracts'
import type { DbOrTx } from '../db/client.ts'
import { insertRevokedSession, markUserDisabled, setTokensNotBefore } from '../repositories/access.repository.ts'

/** Applies auth.session.v1 / auth.user.v1 events to the gateway's access tables. */
export async function handleAccessEvent(db: DbOrTx, envelope: EventEnvelope): Promise<void> {
  switch (envelope.eventType) {
    case 'SessionRevoked':
      await insertRevokedSession(db, envelope.payload as EventPayloads['SessionRevoked'])
      return
    case 'UserDisabled': {
      const { userId } = envelope.payload as EventPayloads['UserDisabled']
      await markUserDisabled(db, userId, envelope.aggregateVersion)
      return
    }
    case 'UserRoleChanged': {
      // Tokens carry the role, so tokens issued before the change must be refused.
      const { userId, changedAt } = envelope.payload as EventPayloads['UserRoleChanged']
      await setTokensNotBefore(db, userId, changedAt, envelope.aggregateVersion)
      return
    }
    default:
      return
  }
}
