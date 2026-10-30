import type { Request, Response } from 'express'
import { forbidden, type EventSender } from '@ecommerce-analytics/platform'
import type { IngestionService } from '../services/ingestion.service.ts'
import type { IngestIdentity } from '../validators/analytics.validator.ts'

/**
 * The client sends the tenant, user and user type its token was issued for (an
 * access token is a registered user's, a visitor token a visitor's); any
 * difference from the token, or a tenant_id header for another tenant, rejects
 * the whole batch before anything is published.
 */
function assertSameIdentity(body: IngestIdentity, header: unknown, sender: EventSender) {
  const same = (sent: unknown, actual: string) => typeof sent === 'string' && sent.toLowerCase() === actual
  const matches =
    same(body.tenantId, sender.tenantId) &&
    same(body.userId, sender.userId) &&
    body.userType === sender.userType &&
    (header === undefined || same(header, sender.tenantId))
  if (!matches) throw forbidden('IDENTITY_MISMATCH', 'tenantId, userId or userType does not match the token')
}

export function createIngestionController(service: IngestionService) {
  return {
    async ingest(req: Request, res: Response) {
      assertSameIdentity(req.body, req.headers.tenant_id, req.sender!)
      // Tenant, user and client type are then taken from the token itself.
      const results = await service.ingest(req.body.events, req.sender!)
      const tally = (status: string) => results.filter((result) => result.status === status).length
      res.json({ accepted: tally('accepted'), rejected: tally('rejected'), results })
    },
  }
}

export type IngestionController = ReturnType<typeof createIngestionController>
