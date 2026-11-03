import type { Request, Response } from 'express'
import type { Counter } from 'prom-client'
import { forbidden, unauthorized, type Caller, type Sender } from '@basketline/platform'
import type { IngestionService } from '../services/ingestion.service.ts'
import type { IngestIdentity } from '../validators/analytics.validator.ts'

/**
 * The client sends the tenant, user and user type its token was issued for (an
 * access token is a registered user's, a visitor token a visitor's); any
 * difference from the token, or a tenant_id header for another tenant, rejects
 * the whole batch before anything is published.
 */
function assertSameIdentity(body: IngestIdentity, header: unknown, sender: Sender) {
  const same = (sent: unknown, actual: string) => typeof sent === 'string' && sent.toLowerCase() === actual
  const matches =
    same(body.tenantId, sender.tenantId) &&
    same(body.userId, sender.userId) &&
    body.userType === sender.userType &&
    (header === undefined || same(header, sender.tenantId))
  if (!matches) throw forbidden('IDENTITY_MISMATCH', 'tenantId, userId or userType does not match the token')
}

/** The sender the gateway verified from an access, visitor or shopper token. */
function senderOf(caller: Caller | undefined): Sender {
  const { tenantId, userId, userType, clientType, tier = null } = caller ?? {}
  if (!tenantId || !userId || !userType || !clientType) throw unauthorized('UNAUTHENTICATED', 'A bearer token (access or visitor) is required')
  return { tenantId, userId, userType, clientType, tier }
}

/** events: counts each event by outcome and rejection reason (ingestion_events_total), for the data-quality alerts. */
export function createIngestionController(service: IngestionService, events: Counter<'outcome' | 'reason'>) {
  return {
    async ingest(req: Request, res: Response) {
      const sender = senderOf(req.caller)
      assertSameIdentity(req.body, req.headers.tenant_id, sender)
      // Tenant, user and client type are then taken from the token itself.
      const results = await service.ingest(req.body.events, sender, req.get('user-agent'), req.body.storeId)
      for (const result of results) events.inc({ outcome: result.status, reason: result.status === 'rejected' ? result.reason : '' })
      const tally = (status: string) => results.filter((result) => result.status === status).length
      res.json({ accepted: tally('accepted'), rejected: tally('rejected'), results })
    },
  }
}

export type IngestionController = ReturnType<typeof createIngestionController>
