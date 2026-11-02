import { vi } from 'vitest'

export const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Stubs the global fetch, which the axios client sends every request through.
 * `handler` receives a plain { url, path, method, headers, body } and returns a
 * Response (or throws, like a network failure). Requests are recorded in order.
 */
export function mockFetch(handler) {
  const requests = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const text = await request.text()
    const call = {
      url: request.url,
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      body: text ? JSON.parse(text) : null,
      keepalive: request.keepalive,
    }
    requests.push(call)
    return handler(call)
  })
  return { requests, restore: () => spy.mockRestore() }
}
