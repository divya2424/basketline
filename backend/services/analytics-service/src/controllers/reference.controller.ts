import type { Request, Response } from 'express'
import type { ReferenceService } from '../services/reference.service.ts'

export function createReferenceController(service: ReferenceService) {
  return {
    /** The tenant comes from the integration token, never from the body. */
    async publish(req: Request, res: Response) {
      const accepted = await service.publish(req.integration!.tid, req.body.events)
      res.status(202).json({ accepted })
    },
  }
}

export type ReferenceController = ReturnType<typeof createReferenceController>
