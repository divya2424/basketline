import type { Request, Response } from 'express'
import type { IngestionService } from '../services/ingestion.service.ts'

export function createIngestionController(service: IngestionService) {
  return {
    async ingest(req: Request, res: Response) {
      // Tenant and user come from the access or visitor token, never from headers or the body.
      const results = await service.ingest(req.body.events, req.sender!)
      const tally = (status: string) => results.filter((result) => result.status === status).length
      res.json({ accepted: tally('accepted'), rejected: tally('rejected'), results })
    },
  }
}

export type IngestionController = ReturnType<typeof createIngestionController>
