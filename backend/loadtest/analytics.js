// k6 load test for the analytics path. One run = one fixed request rate:
//   ingest:    POST /analytics/events, RATE requests/s, each a batch of 10 events
//              (like the browser, which batches events)
//   dashboard: GET /ad/{campaign}/{metric}?from=…, READ_RATE requests/s
// Events go to the load-test tenant (0ad7e570-0000-4000-8000-000000000001, the tenant of the
// "loadtest" campaign manager) and carry properties.loadtest_run = RUN_ID, so
// freshness.sql can measure them and they can be deleted afterwards. Visitors
// send them, each with its own visitor token, on the seeded active campaigns.
import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = __ENV.BASE_URL || 'http://gateway:8080/api/v1'
const RATE = Number(__ENV.RATE || 100)
const READ_RATE = Number(__ENV.READ_RATE || 20)
const DURATION = __ENV.DURATION || '60s'
const RUN_ID = __ENV.RUN_ID || `run-${Date.now()}`
const TENANT = '0ad7e570-0000-4000-8000-000000000001'
const USERNAME = __ENV.LOADTEST_USERNAME || 'loadtest'
const PASSWORD = __ENV.LOADTEST_PASSWORD || 'load test password'
// analytics-service allows 300 events per sender per minute: a visitor sends this
// many batches of 10, then becomes a new visitor.
const BATCHES_PER_VISITOR = 25
const METRICS = ['impressions', 'clicks', 'clickToBasket', 'uniqueCustomers', 'sessions']
const RANGE_DAYS = [7, 30, 90, 365]
const DAY = 24 * 60 * 60 * 1000

const pick = (list) => list[Math.floor(Math.random() * list.length)]

const scenarios = {
  ingest: {
    executor: 'constant-arrival-rate',
    exec: 'ingest',
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(20, Math.ceil(RATE / 5)),
    maxVUs: Math.max(500, RATE * 5),
  },
  dashboard: {
    executor: 'constant-arrival-rate',
    exec: 'dashboard',
    rate: READ_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 10,
    maxVUs: 200,
  },
}

export const options = {
  // A rate of 0 leaves that scenario out, to measure the other one alone.
  scenarios: Object.fromEntries(
    Object.entries(scenarios).filter(([name]) => (name === 'ingest' ? RATE : READ_RATE) > 0),
  ),
  // Targets: the run is marked failed when one is missed. The per-scenario
  // entries also make k6 report each scenario's numbers separately.
  thresholds: {
    'http_req_duration{scenario:ingest}': ['p(99)<500'],
    'http_req_duration{scenario:dashboard}': ['p(99)<1000'],
    'http_req_failed{scenario:ingest}': ['rate<0.01'],
    'http_req_failed{scenario:dashboard}': ['rate<0.01'],
    'http_reqs{scenario:ingest}': ['count>=0'],
    'http_reqs{scenario:dashboard}': ['count>=0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
}

export function setup() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ username: USERNAME, password: PASSWORD, clientType: 'web' }),
    { headers: { 'Content-Type': 'application/json', tenant_id: TENANT } },
  )
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`)
  if (res.json('user.tenantId') !== TENANT) throw new Error(`${USERNAME} must belong to tenant ${TENANT}`)
  // Metric events are only accepted for the load-test tenant's active campaigns.
  const campaigns = http
    .get(`${BASE_URL}/campaigns?status=active&limit=20`, { headers: { Authorization: `Bearer ${res.json('accessToken')}` } })
    .json('items')
  const withProducts = campaigns.filter((campaign) => campaign.productIds.length > 0)
  if (withProducts.length === 0) throw new Error(`no active campaigns with products: run \`npm run seed\` as ${USERNAME} first`)
  return {
    token: res.json('accessToken'),
    campaigns: withProducts.map(({ id, productIds }) => ({ id, productIds })),
  }
}

// Per VU: the current visitor's token and ID, and how many batches it has sent.
let visitor = null

function currentVisitor() {
  if (!visitor || visitor.batches >= BATCHES_PER_VISITOR) {
    const res = http.post(`${BASE_URL}/auth/visitor`, null, { headers: { tenant_id: TENANT }, tags: { name: 'visitor' } })
    if (res.status !== 201) throw new Error(`visitor token failed: ${res.status} ${res.body}`)
    visitor = { header: `Bearer ${res.json('visitorToken')}`, userId: res.json('userId'), batches: 0 }
  }
  visitor.batches += 1
  return visitor
}

function event(eventName, campaignId, productId) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    timestamp: new Date().toISOString(),
    properties: { campaignId, productId, loadtest_run: RUN_ID },
  }
}

/** One browser batch: 6 impressions, 2 clicks, and an add_to_cart of the first click's product (Flink credits it to that click). */
function batch(campaigns) {
  const campaign = pick(campaigns)
  const campaignId = campaign.id
  const productId = pick(campaign.productIds)
  const click = event('click', campaignId, productId)
  return [
    ...Array.from({ length: 6 }, () => event('impression', campaignId)),
    click,
    event('click', campaignId, pick(campaign.productIds)),
    event('add_to_cart', null, productId),
  ]
}

export function ingest(data) {
  const { header, userId } = currentVisitor()
  // The identity the visitor token was issued for; a mismatch is rejected.
  const body = { tenantId: TENANT, userId, userType: 'visitor', events: batch(data.campaigns) }
  const res = http.post(`${BASE_URL}/analytics/events`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: header },
  })
  check(res, { 'events accepted': (r) => r.status === 200 && r.json('rejected') === 0 })
}

export function dashboard(data) {
  const from = new Date(Math.floor(Date.now() / DAY) * DAY - (pick(RANGE_DAYS) - 1) * DAY).toISOString()
  // The tenant comes from the token: the load-test manager reads only the load-test tenant.
  const res = http.get(`${BASE_URL}/ad/${pick(data.campaigns).id}/${pick(METRICS)}?from=${from}`, {
    headers: { Authorization: `Bearer ${data.token}` },
  })
  check(res, { 'metric read': (r) => r.status === 200 })
}

/** One line of JSON per run: what run.sh prints in its table. */
export function handleSummary(data) {
  const m = data.metrics
  const latency = (scenario) => {
    const v = m[`http_req_duration{scenario:${scenario}}`]?.values ?? {}
    return {
      p50_ms: Math.round(v['p(50)']),
      p95_ms: Math.round(v['p(95)']),
      p99_ms: Math.round(v['p(99)']),
      max_ms: Math.round(v.max),
      achieved_rps: Math.round(m[`http_reqs{scenario:${scenario}}`]?.values.rate ?? 0),
      failed_pct: Number(((m[`http_req_failed{scenario:${scenario}}`]?.values.rate ?? 0) * 100).toFixed(2)),
    }
  }
  const summary = {
    run_id: RUN_ID,
    target_rps: RATE,
    target_events_per_s: RATE * 10,
    ingest: latency('ingest'),
    dashboard: latency('dashboard'),
    dropped_iterations: m.dropped_iterations?.values.count ?? 0,
  }
  return { stdout: `${JSON.stringify(summary)}\n` }
}
