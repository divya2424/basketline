import { randomUUID } from 'node:crypto'
import type { CampaignStatus } from '@shopsphere/contracts'
import {
  badRequest,
  conflict,
  event,
  isUniqueViolation,
  notFound,
  retryLater,
  unprocessable,
  writeAudit,
  type NewEvent,
  type PublishEvents,
} from '@shopsphere/platform'
import type { Db, DbOrTx } from '../db/client.ts'
import {
  deleteAssociation,
  findCampaign,
  insertAssociation,
  insertCampaign,
  listCampaignProducts,
  listCampaigns,
  lockCampaign,
  nextPosition,
  updateCampaign,
  type Campaign,
  type CampaignFilter,
} from '../repositories/campaign.repository.ts'
import { findKnownProducts } from '../repositories/product.repository.ts'
import type { CreateCampaignInput, UpdateCampaignInput } from '../validators/campaign.validator.ts'

const RETRY_AFTER_SECONDS = 5

/** Allowed status changes. Completed campaigns are final. */
const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['active', 'completed'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: [],
}

const toDate = (value: string | null | undefined) => (value ? new Date(value) : null)

function assertSchedule(start: Date | null, end: Date | null) {
  if (start && end && end <= start) throw badRequest('INVALID_SCHEDULE', 'endTime must be after startTime')
}

function assertNoDuplicates(productIds: string[]) {
  const duplicates = [...new Set(productIds.filter((id, index) => productIds.indexOf(id) !== index))]
  if (duplicates.length > 0) throw badRequest('DUPLICATE_PRODUCT_IDS', 'productIds contains duplicates', { productIds: duplicates })
}

/**
 * Products are checked against this service's local products copy only — never by
 * calling the product service. Another tenant's products are unknown here.
 * Unknown products get a retryable error because the copy may not have
 * caught up yet.
 */
async function assertProductsAssociable(tx: DbOrTx, tenantId: string, productIds: string[]) {
  if (productIds.length === 0) return
  const known = await findKnownProducts(tx, tenantId, productIds)
  const missing = productIds.filter((id) => !known.has(id))
  if (missing.length > 0) {
    throw retryLater(
      'PRODUCT_NOT_YET_AVAILABLE',
      'Some products are not known to the campaign service yet. If they were just created, retry shortly.',
      RETRY_AFTER_SECONDS,
      { productIds: missing },
    )
  }
  const inactive = productIds.filter((id) => known.get(id) === false)
  if (inactive.length > 0) throw unprocessable('PRODUCT_INACTIVE', 'Inactive products cannot be added to a campaign', { productIds: inactive })
}

async function lockWritable(tx: DbOrTx, tenantId: string, id: string) {
  const campaign = await lockCampaign(tx, tenantId, id)
  if (!campaign) throw notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found')
  if (campaign.archivedAt) throw conflict('CAMPAIGN_ARCHIVED', 'Archived campaigns cannot be changed')
  return campaign
}

async function requireCampaign(db: DbOrTx, tenantId: string, id: string): Promise<Campaign> {
  const campaign = await findCampaign(db, tenantId, id)
  if (!campaign) throw notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found')
  return campaign
}

export function stateEvent(campaign: Omit<Campaign, 'productIds'>, eventType: 'CampaignCreated' | 'CampaignUpdated'): NewEvent {
  return event(eventType, campaign.id, campaign.version, {
    campaignId: campaign.id,
    tenantId: campaign.tenantId,
    title: campaign.title,
    type: campaign.type,
    status: campaign.status,
    startTime: campaign.startTime?.toISOString() ?? null,
    endTime: campaign.endTime?.toISOString() ?? null,
    archived: campaign.archivedAt !== null,
    updatedAt: campaign.updatedAt.toISOString(),
  })
}

/** Inserts the associations and returns their events. Already associated → 409. */
async function addAssociations(tx: DbOrTx, tenantId: string, actorId: string, campaignId: string, productIds: string[], version: number): Promise<NewEvent[]> {
  let position = await nextPosition(tx, campaignId)
  const events: NewEvent[] = []
  for (const productId of productIds) {
    try {
      await insertAssociation(tx, { id: randomUUID(), tenantId, campaignId, productId, position, createdBy: actorId })
    } catch (error) {
      if (isUniqueViolation(error, 'campaign_products_unique')) {
        throw conflict('DUPLICATE_ASSOCIATION', 'Product is already in this campaign', { productIds: [productId] })
      }
      throw error
    }
    events.push(event('CampaignProductAssociated', campaignId, version, { campaignId, productId, position }))
    position += 1
  }
  return events
}

const audit = (tx: DbOrTx, actorId: string, action: string, campaignId: string, details?: object) =>
  writeAudit(tx, { actorId, action, subjectType: 'campaign', subjectId: campaignId, details })

/**
 * Business rules for campaigns. Events are published after each transaction commits.
 * Every method works within one tenant: another tenant's campaign is not found.
 */
export function createCampaignService({ db, publish }: { db: Db; publish: PublishEvents }) {
  return {
    /** The campaign and all its product associations are saved in one transaction. */
    async create(tenantId: string, actorId: string, input: CreateCampaignInput): Promise<Campaign> {
      const productIds = input.productIds ?? []
      assertSchedule(toDate(input.startTime), toDate(input.endTime))
      assertNoDuplicates(productIds)
      const { campaign, events } = await db.transaction(async (tx) => {
        await assertProductsAssociable(tx, tenantId, productIds)
        const created = await insertCampaign(tx, {
          id: randomUUID(),
          tenantId,
          title: input.title.trim(),
          type: input.type.trim(),
          description: input.description ?? null,
          status: input.status ?? 'draft',
          startTime: toDate(input.startTime),
          endTime: toDate(input.endTime),
          createdBy: actorId,
          updatedBy: actorId,
        })
        const associated = await addAssociations(tx, tenantId, actorId, created.id, productIds, created.version)
        await audit(tx, actorId, 'campaign.created', created.id, { productIds })
        return { campaign: await requireCampaign(tx, tenantId, created.id), events: [stateEvent(created, 'CampaignCreated'), ...associated] }
      })
      await publish(events)
      return campaign
    },

    list(filter: CampaignFilter) {
      return listCampaigns(db, filter)
    },

    get(tenantId: string, id: string) {
      return requireCampaign(db, tenantId, id)
    },

    async update(tenantId: string, actorId: string, id: string, input: UpdateCampaignInput): Promise<Campaign> {
      const { campaign, events } = await db.transaction(async (tx) => {
        const current = await lockWritable(tx, tenantId, id)
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw unprocessable('INVALID_STATUS_TRANSITION', `Cannot change status from ${current.status} to ${input.status}`)
        }
        const startTime = input.startTime === undefined ? current.startTime : toDate(input.startTime)
        const endTime = input.endTime === undefined ? current.endTime : toDate(input.endTime)
        assertSchedule(startTime, endTime)
        const updated = await updateCampaign(tx, id, actorId, {
          title: input.title?.trim(),
          type: input.type?.trim(),
          description: input.description,
          status: input.status,
          startTime,
          endTime,
        })
        await audit(tx, actorId, 'campaign.updated', id, { fields: Object.keys(input) })
        return { campaign: await requireCampaign(tx, tenantId, id), events: [stateEvent(updated, 'CampaignUpdated')] }
      })
      await publish(events)
      return campaign
    },

    /** Soft delete. Idempotent. */
    async archive(tenantId: string, actorId: string, id: string): Promise<Campaign> {
      const { campaign, events } = await db.transaction(async (tx) => {
        const current = await lockCampaign(tx, tenantId, id)
        if (!current) throw notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found')
        if (current.archivedAt) return { campaign: await requireCampaign(tx, tenantId, id), events: [] }
        const archived = await updateCampaign(tx, id, actorId, { archivedAt: new Date() })
        await audit(tx, actorId, 'campaign.archived', id)
        return { campaign: await requireCampaign(tx, tenantId, id), events: [stateEvent(archived, 'CampaignUpdated')] }
      })
      await publish(events)
      return campaign
    },

    async addProducts(tenantId: string, actorId: string, id: string, productIds: string[]): Promise<Campaign> {
      assertNoDuplicates(productIds)
      const { campaign, events } = await db.transaction(async (tx) => {
        await lockWritable(tx, tenantId, id)
        await assertProductsAssociable(tx, tenantId, productIds)
        const { version } = await updateCampaign(tx, id, actorId)
        const associated = await addAssociations(tx, tenantId, actorId, id, productIds, version)
        await audit(tx, actorId, 'campaign.products_added', id, { productIds })
        return { campaign: await requireCampaign(tx, tenantId, id), events: associated }
      })
      await publish(events)
      return campaign
    },

    async listProducts(tenantId: string, id: string, limit: number, offset: number) {
      await requireCampaign(db, tenantId, id)
      return listCampaignProducts(db, id, limit, offset)
    },

    async removeProduct(tenantId: string, actorId: string, id: string, productId: string): Promise<void> {
      const events = await db.transaction(async (tx) => {
        await lockWritable(tx, tenantId, id)
        if (!(await deleteAssociation(tx, id, productId))) throw notFound('ASSOCIATION_NOT_FOUND', 'Product is not in this campaign')
        const { version } = await updateCampaign(tx, id, actorId)
        await audit(tx, actorId, 'campaign.product_removed', id, { productId })
        return [event('CampaignProductRemoved', id, version, { campaignId: id, productId })]
      })
      await publish(events)
    },
  }
}

export type CampaignService = ReturnType<typeof createCampaignService>
