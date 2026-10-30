import { vi } from 'vitest'

export const TENANT = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01'
export const CAMPAIGN = '11111111-aaaa-4aaa-8aaa-111111111111'
export const PRODUCT = '22222222-bbbb-4bbb-8bbb-222222222222'

/** A JWT-shaped token with this exp (seconds); only the SDK reads it. */
export const tokenWithExp = (name: string, exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.${name}`

export interface Call {
  path: string
  headers: Headers
  body: any
  keepalive: boolean
}

/** A fake Basketline API: visitor tokens are visitor-1, visitor-2, …; events get `eventsStatus()` (200 by default). */
export function fakeApi(eventsStatus: () => number | Response = () => 200) {
  const calls: Call[] = []
  let visitors = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null, keepalive: Boolean(init?.keepalive) })
    if (url.pathname.endsWith('/auth/visitor')) {
      visitors += 1
      return Response.json({ visitorToken: tokenWithExp(`visitor-${visitors}`, Math.floor(Date.now() / 1000) + 1800) }, { status: 201 })
    }
    const status = eventsStatus()
    return status instanceof Response ? status : Response.json(status === 200 ? { accepted: 1 } : { error: { code: 'X' } }, { status })
  })
  const eventCalls = () => calls.filter((call) => call.path.endsWith('/analytics/events'))
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, eventCalls }
}

export const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}
