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
 *      marketplace, from the ten shoppers and a few new visitors a day (busier
 *      on weekends, growing towards today):
 *      - the last 2 days through Basketline's API, like today's (signed-in
 *        shoppers only: visitor tokens are limited to 10 a minute);
 *      - older days, which the API no longer takes, into Basketline's data lake
 *        with its history import job, then its history backfill recomputes those
 *        days' analytics from the lake (basketline/airflow/README.md). This needs
 *        Basketline's airflow and archive-storage containers.
 *
 *   pnpm seed:demo        # in retailer-sim/, with both stacks running
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const NAME = process.env.SEED_STORE_NAME ?? 'Demo Mart'
const AUTH = process.env.RETAILER_AUTH_URL ?? 'http://localhost:4006/api/v1'
const CAMPAIGNS = process.env.CAMPAIGN_URL ?? 'http://localhost:4003/api/v1'
const BASKETLINE = process.env.BASKETLINE_API_URL ?? 'http://localhost:8080/api/v1'
const BASKETLINE_DIR = path.join(import.meta.dirname, '..', '..', 'basketline')
const HISTORY_DAYS = Number(process.env.SEED_HISTORY_DAYS ?? 30)
/** The days before today Basketline's API still takes events for; older ones go to the lake. */
const API_DAYS = 2
/** The history backfill recomputes days at least this old (backfill_daily.py's SETTLED_DAYS). */
const SETTLED_DAYS = 3
const DAY = 86_400_000
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

/**
 * Sends a shopper's events with their token, as the SDK does; returns how many Basketline accepted.
 * Basketline counts impressions and clicks only for campaigns it knows to be active, which a new
 * marketplace's are a second or two after campaign-service has them: those are sent again for up to 30 s.
 */
async function send(tenantId: string, token: string, userId: string, userType: 'visitor' | 'registered', events: { eventId: string }[]) {
  let accepted = 0
  for (let i = 0; i < events.length; i += BATCH) {
    let batch = events.slice(i, i + BATCH)
    for (let attempt = 0; batch.length > 0; attempt++) {
      const result = await call(`${BASKETLINE}/analytics/events`, { headers: { authorization: `Bearer ${token}` }, body: { tenantId, userId, userType, events: batch } })
      accepted += result.accepted
      const rejected = result.results.filter((r: { status: string }) => r.status !== 'accepted') as { eventId: string; reason: string }[]
      const unknownCampaign = new Set(rejected.filter((r) => r.reason === 'UNKNOWN_CAMPAIGN').map((r) => r.eventId))
      if (rejected.length > unknownCampaign.size || (unknownCampaign.size > 0 && attempt === 15)) {
        throw new Error(`Basketline rejected ${rejected.length} events: ${JSON.stringify(rejected.slice(0, 3))}`)
      }
      batch = batch.filter((event) => unknownCampaign.has(event.eventId))
      if (batch.length > 0) await pause(2000)
    }
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

type Shopper = { userId: string; clientType: ClientType; token: string }

/** Runs a Basketline Airflow job (basketline/airflow/jobs) in its container; returns its exit code. */
function airflowJob(args: string[], input?: string) {
  const run = spawnSync('docker', ['compose', 'exec', '-T', 'airflow', '/opt/jobs/bin/python', ...args], { cwd: BASKETLINE_DIR, input, encoding: 'utf8' })
  if (run.error) throw run.error
  process.stdout.write(run.stdout)
  process.stderr.write(run.stderr)
  return run.status
}

/** One random visit on the day `back` days ago: each campaign's products seen, about 30% clicked, 40% of those added to the cart. */
function pastVisit(list: Campaign[], back: number) {
  const day = new Date()
  day.setUTCHours(0, 0, 0, 0)
  // Between 08:00 and 22:00 UTC; on a day sent through the API, inside its 2-day limit.
  const earliest = day.getTime() - back * DAY + 8 * 3_600_000
  const from = back <= API_DAYS ? Math.max(earliest, Date.now() - (API_DAYS * 24 - 2) * 3_600_000) : earliest
  const to = day.getTime() - back * DAY + 22 * 3_600_000
  let at = from + Math.random() * (to - from)
  return browse(list, () => new Date((at += 2000 + Math.floor(Math.random() * 8000))).toISOString(), () => Math.random() < 0.3, () => Math.random() < 0.4)
}

/** Who shops on the day `back` days ago: some of the shoppers (more on weekends and nearer today), and 2–6 new visitors. */
function pastShoppers(shoppers: Shopper[], back: number) {
  const weekday = new Date(Date.now() - back * DAY).getUTCDay()
  const share = (0.35 + 0.4 * (1 - back / (HISTORY_DAYS + 1))) * ([0, 6].includes(weekday) ? 1.3 : 1)
  const visitors = Array.from({ length: 2 + Math.floor(Math.random() * 5) }, (_, v) => ({ userId: randomUUID(), clientType: (v % 4 === 3 ? 'mobile' : 'web') as ClientType }))
  return { registered: shoppers.filter(() => Math.random() < share), visitors }
}

async function history(tenantId: string, list: Campaign[], shoppers: Shopper[]) {
  // The lake: the days the API no longer takes, as ingestion-service publishes events. One day more
  // than the backfill recomputes: the backfill takes only days after the lake began.
  const lake: string[] = []
  for (let back = HISTORY_DAYS + 1; back > API_DAYS; back--) {
    const { registered, visitors } = pastShoppers(shoppers, back)
    for (const [userType, group] of [['registered', registered], ['visitor', visitors]] as const) {
      for (const { userId, clientType } of group) {
        for (const event of pastVisit(list, back)) {
          const { campaignId = null, productId = null } = event.properties as { campaignId?: string; productId?: string }
          const receivedAt = new Date(Date.parse(event.timestamp) + 1000).toISOString()
          lake.push(JSON.stringify({ ...event, properties: undefined, tenantId, campaignId, productId, userId, userType, clientType, receivedAt }))
        }
      }
    }
  }
  const imported = airflowJob(['/opt/airflow/jobs/import_history.py', '--tenant', tenantId], lake.join('\n'))
  if (imported !== 0 && imported !== 3) throw new Error(`The history import failed (exit ${imported}): are Basketline's airflow and archive-storage running?`)
  if (imported === 0) {
    // The last 2 days, through the API like today's, once: only when the older history was imported now.
    let sent = 0
    for (let back = API_DAYS; back >= 1; back--) {
      for (const { userId, token } of pastShoppers(shoppers, back).registered) sent += await send(tenantId, token, userId, 'registered', pastVisit(list, back))
    }
    console.log(`History: imported ${lake.length} events into the lake, and sent ${sent} for the last ${API_DAYS} days through the API.`)
  }
  // Recompute the lake's days in ClickHouse, with the live rules (safe to run again).
  const day = (back: number) => new Date(Date.now() - back * DAY).toISOString().slice(0, 10)
  const backfilled = airflowJob(['/opt/airflow/jobs/backfill_daily.py', '--from', day(HISTORY_DAYS), '--to', day(SETTLED_DAYS), '--tenant', tenantId])
  if (backfilled !== 0) throw new Error(`The history backfill failed (exit ${backfilled})`)
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
    shoppers.push({ ...shopper, clientType })
  } else {
    const shopper = await signIn(tenantId, username, clientType)
    accepted += await send(tenantId, shopper.token, shopper.userId, 'registered', browse(list, at, clicks, adds))
    shoppers.push({ ...shopper, clientType })
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
