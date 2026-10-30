import { buildEvent, type ApiEvent, type EventFields, type EventName } from './events'
import { tokenExpiry, visitorIdFor, type KeyValueStorage } from './identity'

export interface BasketlineOptions {
  /** The Basketline API, e.g. "https://api.basketline.io/api/v1". */
  apiUrl: string
  /** Your store's tenant ID (UUID), from Basketline. */
  tenantId: string
  /** The app the events come from (default "web"). */
  clientType?: 'web' | 'mobile'
  /** Events per request (default 20, at most 100). */
  batchSize?: number
  /** How long the first queued event waits for others (default 2000 ms). */
  flushAfterMs?: number
  /** Where the visitor ID is kept (default localStorage; without one, it lasts for the page). */
  storage?: KeyValueStorage
  /** Called with anything that went wrong; the SDK never throws into your page. */
  onError?: (error: BasketlineError) => void
  /** Logs each event and request to the console. */
  debug?: boolean
  /** The fetch to use (default globalThis.fetch); for tests and unusual runtimes. */
  fetch?: typeof fetch
}

export interface Identify {
  /** The ID Basketline returned for this shopper with their token (POST /auth/shopper-token's userId). */
  userId: string
  /** Returns a token for this shopper: a shopper token from your backend (or a Basketline access token). */
  getToken: () => string | Promise<string>
}

export class BasketlineError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; code?: string; event?: unknown; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'BasketlineError'
  }
}

type Sender = { kind: 'visitor' } | ({ kind: 'registered' } & Identify)
interface Batch {
  sender: Sender
  events: ApiEvent[]
}

/** Visitor tokens last 30 minutes; a new one is fetched a little before. Other tokens: before their exp. */
const RENEW_BEFORE_MS = 5 * 60 * 1000
const FALLBACK_TOKEN_MS = 25 * 60 * 1000
const MAX_RETRY_WAIT_MS = 10_000

/**
 * The Basketline client for one store. Events are queued and posted in batches
 * (batchSize, or flushAfterMs after the first, or when the page is hidden), with
 * the identity their token was issued for: the visitor's, or after identify(),
 * the signed-in shopper's. Nothing it does can break the page: problems go to
 * onError.
 */
export function createBasketline(options: BasketlineOptions) {
  const {
    apiUrl,
    tenantId,
    clientType = 'web',
    batchSize = 20,
    flushAfterMs = 2000,
    onError = (error: BasketlineError) => console.warn('[basketline]', error.message, error.details),
    debug = false,
  } = options
  const base = apiUrl.replace(/\/+$/, '')
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init)
  const newId = () => crypto.randomUUID()
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : safeLocalStorage())
  const limit = Math.min(Math.max(1, batchSize), 100)

  let sender: Sender = { kind: 'visitor' }
  let queue: ApiEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()
  // One cached token per sender: the visitor's, and the current shopper's.
  const tokens = new Map<Sender, { token: Promise<string>; renewAt: number }>()

  const report = (error: BasketlineError) => {
    try {
      onError(error)
    } catch {
      // A failing onError mustn't break the page either.
    }
  }
  const log = (...args: unknown[]) => debug && console.debug('[basketline]', ...args)

  function visitorId() {
    return visitorIdFor(tenantId, storage, newId)
  }

  async function fetchVisitorToken(): Promise<string> {
    const res = await doFetch(`${base}/auth/visitor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', tenant_id: tenantId },
      body: JSON.stringify({ userId: visitorId(), clientType }),
    })
    if (!res.ok) throw await apiError(res, 'could not get a visitor token')
    return ((await res.json()) as { visitorToken: string }).visitorToken
  }

  function tokenFor(who: Sender, fresh = false): Promise<string> {
    const cached = tokens.get(who)
    if (cached && !fresh && cached.renewAt > Date.now()) return cached.token
    const token = Promise.resolve(who.kind === 'visitor' ? fetchVisitorToken() : who.getToken())
    const entry = { token, renewAt: Date.now() + FALLBACK_TOKEN_MS }
    tokens.set(who, entry)
    token.then(
      (value) => {
        const exp = tokenExpiry(value)
        if (exp) entry.renewAt = exp - RENEW_BEFORE_MS
      },
      // A failed request is retried with the next batch.
      () => tokens.get(who) === entry && tokens.delete(who),
    )
    return token
  }

  function identity(who: Sender) {
    return who.kind === 'visitor' ? { userId: visitorId(), userType: 'visitor' } : { userId: who.userId.toLowerCase(), userType: 'registered' }
  }

  async function post(batch: Batch, token: string) {
    return doFetch(`${base}/analytics/events`, {
      method: 'POST',
      // keepalive: the last batch still arrives while the page unloads.
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, tenant_id: tenantId },
      body: JSON.stringify({ tenantId, ...identity(batch.sender), events: batch.events }),
    })
  }

  /** Sends one batch: a 401 gets a fresh token once, a 429 or 5xx (or no network) one retry after a pause. */
  async function deliver(batch: Batch) {
    let res: Response | undefined
    let retried = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await post(batch, await tokenFor(batch.sender, attempt > 0 && res?.status === 401))
      } catch (cause) {
        if (retried) throw new BasketlineError('events not sent: network error', { cause })
        retried = true
        await pause(1000)
        continue
      }
      if (res.ok) {
        log('sent', batch.events.length, 'events')
        return
      }
      if (res.status === 401 && attempt === 0) continue
      if ((res.status === 429 || res.status >= 500) && !retried) {
        retried = true
        await pause(Math.min(Number(res.headers.get('Retry-After') ?? 1) * 1000 || 1000, MAX_RETRY_WAIT_MS))
        continue
      }
      break
    }
    throw await apiError(res!, `${batch.events.length} events not sent`)
  }

  function flushNow(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return inFlight
    const batches: Batch[] = []
    for (let i = 0; i < queue.length; i += limit) batches.push({ sender, events: queue.slice(i, i + limit) })
    queue = []
    // In order, so a shopper's batches never overtake each other.
    inFlight = inFlight.then(() =>
      batches.reduce<Promise<void>>((chain, batch) => chain.then(() => deliver(batch).catch((error) => report(asError(error)))), Promise.resolve()),
    )
    return inFlight
  }

  function enqueue(eventName: string, fields: EventFields): string | null {
    try {
      const built = buildEvent(eventName, fields, newId(), new Date())
      if ('error' in built) {
        report(new BasketlineError(`event dropped: ${built.error}`, { event: { eventName, ...fields } }))
        return null
      }
      if (built.dropped.length > 0) report(new BasketlineError(`properties dropped (personal data): ${built.dropped.join(', ')}`, { event: built.event }))
      queue.push(built.event)
      log('queued', built.event)
      if (queue.length >= limit) void flushNow()
      else timer ??= setTimeout(() => void flushNow(), flushAfterMs)
      return built.event.eventId
    } catch (error) {
      report(asError(error))
      return null
    }
  }

  if (typeof document !== 'undefined') {
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void flushNow()
    }
    document.addEventListener('visibilitychange', flushOnHide)
    addEventListener('pagehide', () => void flushNow())
  }

  return {
    /** Any event (see EVENT_NAMES). Returns its eventId, or null if it was invalid (see onError). */
    track: (eventName: EventName, fields: EventFields = {}) => enqueue(eventName, fields),
    /** An ad of the campaign was seen. */
    impression: ({ campaignId, ...fields }: EventFields & { campaignId: string }) => enqueue('impression', { campaignId, ...fields }),
    /** An ad was clicked, opening a product: an add to cart of that product in the next 7 days is credited to it. */
    click: ({ campaignId, productId, ...fields }: EventFields & { campaignId: string; productId?: string }) =>
      enqueue('click', { campaignId, productId, ...fields }),
    /** A product was added to the cart; Basketline credits it to the shopper's latest ad click on it. */
    addToCart: ({ productId, quantity, ...fields }: EventFields & { productId: string; quantity?: number }) =>
      enqueue('add_to_cart', { productId, ...fields, properties: { ...(quantity === undefined ? {} : { quantity }), ...fields.properties } }),

    /** The shopper signed in: later events are theirs. Earlier queued events still go out as the visitor. */
    identify(shopper: Identify) {
      void flushNow()
      sender = { kind: 'registered', userId: shopper.userId, getToken: shopper.getToken }
    },
    /** The shopper signed out: back to this browser's visitor. */
    reset() {
      void flushNow()
      if (sender.kind === 'registered') tokens.delete(sender)
      sender = { kind: 'visitor' }
    },
    /** This browser's visitor ID for the store: send it to your backend's shopper-token call, so the visitor and the shopper stay one person. */
    get visitorId() {
      return visitorId()
    },
    /** Sends everything queued; resolves when it has been sent (or reported to onError). */
    flush: () => flushNow(),
  }
}

export type Basketline = ReturnType<typeof createBasketline>

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function asError(error: unknown): BasketlineError {
  return error instanceof BasketlineError ? error : new BasketlineError(error instanceof Error ? error.message : String(error), { cause: error })
}

async function apiError(res: Response, message: string): Promise<BasketlineError> {
  let code: string | undefined
  try {
    code = ((await res.json()) as { error?: { code?: string } }).error?.code
  } catch {
    // Not JSON.
  }
  return new BasketlineError(`${message} (${res.status}${code ? ` ${code}` : ''})`, { status: res.status, code })
}

function safeLocalStorage(): KeyValueStorage | undefined {
  try {
    return localStorage
  } catch {
    return undefined
  }
}
