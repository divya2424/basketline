import type { Request, Response } from 'express'
import type { Account } from '../repositories/account.repository.ts'
import type { AccountService } from '../services/account.service.ts'

/** Dates become ISO strings in res.json. */
const toPublicAccount = ({ tenantId, name, tier, createdAt }: Account) => ({ tenantId, name, tier, createdAt })

export function createAccountController(service: AccountService) {
  return {
    async list(_req: Request, res: Response) {
      res.json({ items: (await service.list()).map(toPublicAccount) })
    },

    async remove(req: Request<{ tenantId: string }>, res: Response) {
      const deleted = await service.deleteTenant(req.params.tenantId.toLowerCase(), req.body.confirmName)
      res.json({ deleted })
    },

    async onboard(req: Request, res: Response) {
      const { account, users, password, apiKey, seed } = await service.onboard(req.body)
      res.status(201).json({ account: toPublicAccount(account), users, password, apiKey, seed })
    },
  }
}

export type AccountController = ReturnType<typeof createAccountController>
