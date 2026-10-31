import type { CryptoKey } from 'jose'
import {
  authenticate,
  createBaseApp,
  createEventPublisher,
  createHealth,
  errorHandler,
  notFoundHandler,
  optionalAuth,
  pingDb,
  type EventBus,
  type Health,
  type Logger,
  type RetailerIntegration,
} from '@basketline/platform'
import type { Db } from './db/client.ts'
import { createCampaignController } from './controllers/campaign.controller.ts'
import { campaignRoutes } from './routes/campaign.routes.ts'
import { createCampaignService } from './services/campaign.service.ts'

export interface CampaignAppDeps {
  db: Db
  bus: EventBus
  logger: Logger
  publicKey: CryptoKey
  /** Sends each campaign's state to Basketline (platform retailer.ts); none in tests. */
  retailer?: RetailerIntegration
  /** Probe state from index.ts; tests get one that's already started. */
  health?: Health
}

/** Builds the Express app: service → controller → routes. */
export function buildCampaignApp({ db, bus, logger, publicKey, retailer, health = createHealth({ started: true }) }: CampaignAppDeps) {
  health.addCheck('database', () => pingDb(db))
  const app = createBaseApp({ name: 'campaign-service', logger, health })

  const service = createCampaignService({ db, publish: createEventPublisher(bus, 'campaign-service', logger), retailer })
  const controller = createCampaignController(service)

  app.use('/api/v1/campaigns', campaignRoutes(controller, { authenticate: authenticate(publicKey), optionalAuth: optionalAuth(publicKey) }))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
