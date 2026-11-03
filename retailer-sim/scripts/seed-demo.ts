/**
 * A demo marketplace with shopping activity, so the seller portal's analytics
 * have data right after setup. Through the same public routes the storefront
 * uses, against the running stack:
 *
 *   1. Adds the marketplace (default "Demo Mart") on the Marketplaces API, unless
 *      it exists: it's onboarded at Basketline and seeded with two sellers, their
 *      products and campaigns, and the logins seller1, seller2, user01–user10.
 *   2. Waits for its campaigns, then sends shoppers' events to Basketline:
 *      - user01–user10, each signed in (users 03, 06 and 09 on the mobile app):
 *        they see every campaign's products, click some and add some of those to
 *        the cart; user01 browses signed out first, then signs in (one person);
 *      - 4 visitors who never sign in: they see everything, two of them click.
 *
 * Event times are the last few minutes, so they count in today's numbers and in
 * sessions (shown about 40 minutes later). Each run adds another round of
 * activity; the marketplace and its logins are reused.
 *
 *   3. History: the 30 days before today (SEED_HISTORY_DAYS), once per
 *      marketplace. Basketline's API takes events at most 2 days old, so these are
 *      written straight into its ClickHouse staging tables, as its Flink job
 *      writes them (impressions and clicks, credited add-to-carts, sessions):
 *      the materialized views count them into the daily tables /ad reads. Local
 *      demo data only: it is not in the data lake, and stored as of its own time,
 *      so the hourly check leaves those days alone.
 *
 *   pnpm seed:demo        # in retailer-sim/, with both stacks running
 */
import { randomUUID } from 'node:crypto'

const NAME = process.env.SEED_STORE_NAME ?? 'Demo Mart'
const AUTH = process.env.RETAILER_AUTH_URL ?? 'http://localhost:4006/api/v1'
const CAMPAIGNS = process.env.CAMPAIGN_URL ?? 'http://localhost:4003/api/v1'
const BASKETLINE = process.env.BASKETLINE_API_URL ?? 'http://localhost:8080/api/v1'
const CLICKHOUSE = process.env.CLICKHOUSE_URL ?? 'http://basketline:basketline_dev@localhost:8123'
const HISTORY_DAYS = Number(process.env.SEED_HISTORY_DAYS ?? 30)
const PASSWORD = 'test'
const USERS = Array.from({ length: 10 }, (_, i) => `user${String(i + 1).padStart(2, '0')}`)
const VISITORS = 4
/** Events per request (Basketline's limit). */
const BATCH = 100

type ClientType = 'web' | 'mobile'
type Campaign = { id: string; sellerId: string; title: string; productIds: string[] }

// `any`: this script reads only a few documented response fields.
async function call(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<any> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} failed (${res.status}): ${JSON.stringify(json)}`)
  return json
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The marketplace's tenant: the existing one of that name, else a new one. */
async function marketplace(): Promise<string> {
  const { items } = await call(`${AUTH}/stores`)
  const existing = items.find((store: { name: string }) => store.name === NAME)
  if (existing) {
    console.log(`Using the marketplace "${NAME}" (${existing.tenantId}).`)
    return existing.tenantId
  }
  const { store } = await call(`${AUTH}/stores`, { body: { name: NAME, tier: 'pro' } })
  console.log(`Added the marketplace "${NAME}" (${store.tenantId}); logins: seller1, seller2, user01–user10, password "${PASSWORD}".`)
  return store.tenantId
}

/** Its active campaigns, once campaign-service has seeded them from the new store (a few seconds). */
async function campaigns(tenantId: string): Promise<Campaign[]> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { items } = await call(`${CAMPAIGNS}/campaigns?status=active&limit=100`, { headers: { tenant_id: tenantId } })
    const ready = (items as Campaign[]).filter((campaign) => campaign.sellerId && campaign.productIds.length > 0)
    if (ready.length > 0) return ready
    await pause(1000)
  }
  throw new Error(`No active campaigns for "${NAME}" after a minute: is campaign-service running?`)
}

/** A clock for one shopper's events: from `start`, a few seconds apart, in order. */
function clock(start: number) {
  let at = start
  return () => new Date((at += 2000 + Math.floor(Math.random() * 3000))).toISOString()
}

/**
 * What one shopper does: sees every campaign's products, clicks those that
 * `clicks` picks, and adds to the cart those `adds` picks among them. Each event
 * names the campaign's seller (its store), as the storefront does.
 */
function browse(list: Campaign[], at: () => string, clicks: (c: number, p: number) => boolean, adds: (c: number, p: number) => boolean) {
  const events = []
  const event = (eventName: string, campaign: Campaign, properties: Record<string, unknown>) => ({
    eventId: randomUUID(),
    eventName,
    storeId: campaign.sellerId,
    timestamp: at(),
    pageName: 'home',
    featureName: 'seed',
    properties,
  })
  for (const [c, campaign] of list.entries()) {
    for (const productId of campaign.productIds) events.push(event('impression', campaign, { campaignId: campaign.id, productId }))
    for (const [p, productId] of campaign.productIds.entries()) {
      if (!clicks(c, p)) continue
      events.push(event('click', campaign, { campaignId: campaign.id, productId }))
      // An add to the cart names only the product: Basketline credits it to the shopper's latest click on it.
      if (adds(c, p)) events.push(event('add_to_cart', campaign, { productId }))
    }
  }
  return events
}

/** Sends a shopper's events with their token, as the SDK does; returns how many Basketline accepted. */
async function send(tenantId: string, token: string, userId: string, userType: 'visitor' | 'registered', events: unknown[]) {
  let accepted = 0
  for (let i = 0; i < events.length; i += BATCH) {
    const result = await call(`${BASKETLINE}/analytics/events`, {
      headers: { authorization: `Bearer ${token}` },
      body: { tenantId, userId, userType, events: events.slice(i, i + BATCH) },
    })
    if (result.rejected > 0) throw new Error(`Basketline rejected ${result.rejected} events: ${JSON.stringify(result.results.filter((r: { status: string }) => r.status !== 'accepted').slice(0, 3))}`)
    accepted += result.accepted
  }
  return accepted
}

async function visitor(tenantId: string, clientType: ClientType) {
  const userId = randomUUID()
  const { visitorToken } = await call(`${BASKETLINE}/auth/visitor`, { headers: { tenant_id: tenantId }, body: { userId, clientType } })
  return { userId, token: visitorToken as string }
}

async function signIn(tenantId: string, username: string, clientType: ClientType, visitorId?: string) {
  const result = await call(`${AUTH}/auth/login`, { headers: { tenant_id: tenantId }, body: { username, password: PASSWORD, clientType, ...(visitorId ? { visitorId } : {}) } })
  if (!result.basketline) throw new Error(`${username} got no Basketline shopper token: is the marketplace connected to Basketline?`)
  return { userId: result.basketline.userId as string, token: result.basketline.shopperToken as string }
}

/** Runs a ClickHouse statement over HTTP; rows: a JSONEachRow body for an INSERT. */
async function clickhouse(query: string, rows?: object[]): Promise<string> {
  const url = new URL(CLICKHOUSE)
  const auth = { 'X-ClickHouse-User': decodeURIComponent(url.username), 'X-ClickHouse-Key': decodeURIComponent(url.password) }
  url.username = url.password = ''
  url.search = new URLSearchParams({ query, date_time_input_format: 'best_effort' }).toString()
  const res = await fetch(url, { method: 'POST', headers: auth, body: rows?.map((row) => JSON.stringify(row)).join('\n') })
  const text = await res.text()
  if (!res.ok) throw new Error(`ClickHouse: ${text.slice(0, 300)}`)
  return text
}

type Shopper = { userId: string; clientType: ClientType }

/**
 * The days before today, as Basketline's Flink job would have written them: on
 * each day some of the shoppers (and a few new visitors) see the campaigns'
 * products, click some and add some of those to the cart, in one session each.
 * Weekends are busier, and activity grows towards today.
 */
async function history(tenantId: string, list: Campaign[], shoppers: Shopper[]) {
  const [done] = (await clickhouse(`SELECT count() FROM analytics.daily_campaign_aggregation WHERE tenant_id = '${tenantId}' AND day < today()`)).trim().split('\n')
  if (Number(done) > 0) return console.log(`History: "${NAME}" already has days before today; not added again.`)

  const events: object[] = []
  const baskets: object[] = []
  const sessions: object[] = []
  const iso = (ms: number) => new Date(ms).toISOString()
  for (let back = HISTORY_DAYS; back >= 1; back--) {
    const day = new Date()
    day.setUTCHours(0, 0, 0, 0)
    day.setUTCDate(day.getUTCDate() - back)
    const weekend = [0, 6].includes(day.getUTCDay())
    const share = (0.35 + 0.4 * (1 - back / HISTORY_DAYS)) * (weekend ? 1.3 : 1)
    const visitors = Array.from({ length: 2 + Math.floor(Math.random() * 5) }, (_, v): Shopper & { userType: string } => ({ userId: randomUUID(), clientType: v % 4 === 3 ? 'mobile' : 'web', userType: 'visitor' }))
    const active = [...shoppers.filter(() => Math.random() < share).map((shopper) => ({ ...shopper, userType: 'registered' })), ...visitors]
    for (const { userId, clientType, userType } of active) {
      // One visit, between 08:00 and 22:00 UTC, its events a few seconds apart.
      let at = day.getTime() + (8 + Math.random() * 14) * 3_600_000
      const start = at
      const firstEvent = events.length
      const next = () => (at += 2000 + Math.floor(Math.random() * 8000))
      const seen = new Set<string>()
      const clicked: string[] = []
      const added: string[] = []
      const row = (eventName: string, campaign: Campaign, productId: string, eventTime: number) => {
        const event = { event_id: randomUUID(), event_name: eventName, tenant_id: tenantId, store_id: campaign.sellerId, campaign_id: campaign.id, product_id: productId, user_id: userId, user_type: userType, client_type: clientType, event_time: iso(eventTime), received_at: iso(eventTime), ingested_at: iso(eventTime) }
        events.push(event)
        return event
      }
      for (const campaign of list) {
        seen.add(`${campaign.sellerId}:${campaign.id}`)
        for (const productId of campaign.productIds) row('impression', campaign, productId, next())
        for (const productId of campaign.productIds) {
          if (Math.random() >= 0.3) continue
          const click = row('click', campaign, productId, next())
          clicked.push(`${campaign.id}:${productId}`)
          if (Math.random() >= 0.4) continue
          // An add to the cart, credited to this click (the latest on the product).
          const addedAt = next()
          added.push(productId)
          baskets.push({ basket_event_id: randomUUID(), click_event_id: click.event_id, tenant_id: tenantId, store_id: campaign.sellerId, campaign_id: campaign.id, product_id: productId, user_id: userId, user_type: userType, client_type: clientType, event_time: iso(addedAt), click_time: click.event_time, ingested_at: iso(addedAt) })
        }
      }
      sessions.push({ tenant_id: tenantId, user_id: userId, user_type: userType, session_start: iso(start), session_end: iso(at), events: events.length - firstEvent + added.length, web: clientType === 'web', mobile: clientType === 'mobile', campaigns: [...seen], clicked, added, ingested_at: iso(at) })
    }
  }
  await clickhouse('INSERT INTO analytics.events FORMAT JSONEachRow', events)
  await clickhouse('INSERT INTO analytics.attributed_baskets FORMAT JSONEachRow', baskets)
  await clickhouse('INSERT INTO analytics.sessions FORMAT JSONEachRow', sessions)
  console.log(`History: ${HISTORY_DAYS} days before today for "${NAME}": ${events.length} impressions and clicks, ${baskets.length} add-to-carts, ${sessions.length} sessions.`)
}

const tenantId = await marketplace()
const list = await campaigns(tenantId)
const shoppers: Shopper[] = []
// The last 8 minutes: recent enough to count in sessions (events more than 10 minutes behind the newest are too late for them).
const start = Date.now() - 8 * 60_000
let accepted = 0

for (const [i, username] of USERS.entries()) {
  const clientType: ClientType = i % 3 === 2 ? 'mobile' : 'web'
  const at = clock(start + i * 20_000)
  // Different shoppers click different products; about half of the clicks lead to the cart.
  const clicks = (c: number, p: number) => (i + c + p) % 3 === 0
  const adds = (c: number, p: number) => (i + c + p) % 2 === 0
  if (i === 0) {
    // Browses signed out first, then signs in keeping the visitor ID: one person, counted as both.
    const anonymous = await visitor(tenantId, clientType)
    accepted += await send(tenantId, anonymous.token, anonymous.userId, 'visitor', browse(list, at, () => false, () => false))
    const shopper = await signIn(tenantId, username, clientType, anonymous.userId)
    accepted += await send(tenantId, shopper.token, shopper.userId, 'registered', browse(list, at, clicks, adds))
    shoppers.push({ userId: shopper.userId, clientType })
  } else {
    const shopper = await signIn(tenantId, username, clientType)
    accepted += await send(tenantId, shopper.token, shopper.userId, 'registered', browse(list, at, clicks, adds))
    shoppers.push({ userId: shopper.userId, clientType })
  }
}

for (let v = 0; v < VISITORS; v++) {
  const anonymous = await visitor(tenantId, v === VISITORS - 1 ? 'mobile' : 'web')
  const at = clock(start + (USERS.length + v) * 20_000)
  accepted += await send(tenantId, anonymous.token, anonymous.userId, 'visitor', browse(list, at, (c, p) => v < 2 && c === 0 && p === v, () => false))
}

console.log(
  `Sent ${accepted} events to Basketline for "${NAME}": ${USERS.length} signed-in shoppers and ${VISITORS} visitors over ${list.length} campaigns (${list.map((c) => c.title).join(', ')}).`,
)
await history(tenantId, list, shoppers)
console.log('Sign in as seller1 or seller2 on the Marketplaces page to see their campaigns\' analytics (within about a minute; sessions about 40 minutes later).')
