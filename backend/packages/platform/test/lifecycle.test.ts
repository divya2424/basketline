import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createBaseApp, createHealth, createLogger, handleShutdown } from '../src/index.ts'

const logger = createLogger('lifecycle-test')

describe('health probes', () => {
  it('live is always 200; startup and ready wait for markStarted', async () => {
    const health = createHealth()
    const app = createBaseApp({ name: 'svc', logger, health })
    expect((await request(app).get('/health/live')).status).toBe(200)
    expect((await request(app).get('/health/startup')).body).toEqual({ status: 'starting', service: 'svc' })
    expect((await request(app).get('/health/ready')).status).toBe(503)

    health.markStarted()
    expect((await request(app).get('/health/startup')).status).toBe(200)
    const ready = await request(app).get('/health/ready')
    expect(ready.status).toBe(200)
    expect(ready.body).toEqual({ status: 'ready', service: 'svc', checks: {} })
  })

  it('ready reports each check and fails if one fails or times out; live stays 200', async () => {
    const health = createHealth({ started: true, checkTimeoutMs: 50 })
    health.addCheck('database', async () => {})
    health.addCheck('kafka', () => Promise.reject(new Error('broker unreachable')))
    health.addCheck('slow', () => sleep(500))
    const app = createBaseApp({ name: 'svc', logger, health })

    const ready = await request(app).get('/health/ready')
    expect(ready.status).toBe(503)
    expect(ready.body.checks).toEqual({ database: 'ok', kafka: 'broker unreachable', slow: 'timed out after 50ms' })
    expect((await request(app).get('/health/live')).status).toBe(200)
  })
})

describe('graceful shutdown', () => {
  it('fails readiness first, finishes in-flight requests, refuses new ones, then closes resources in order', async () => {
    const health = createHealth({ started: true })
    const app = createBaseApp({ name: 'svc', logger, health })
    app.get('/slow', async (_req, res) => {
      await sleep(300)
      res.json({ done: true })
    })
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const order: string[] = []
    let exitCode: number | undefined
    const shutdown = handleShutdown({
      logger,
      server,
      health,
      drainDelayMs: 100,
      timeoutMs: 5_000,
      registerProcessHandlers: false,
      exit: (code) => {
        exitCode = code
      },
      closers: [
        { name: 'kafka', close: async () => void order.push('kafka') },
        { name: 'database', close: async () => void order.push('database') },
      ],
    })

    const inFlight = fetch(`${base}/slow`).then((res) => res.json())
    await sleep(20)
    const done = shutdown('test')

    // Readiness fails immediately, while the server is still draining.
    const ready = await fetch(`${base}/health/ready`)
    expect(ready.status).toBe(503)
    expect(await ready.json()).toMatchObject({ status: 'shutting_down' })

    expect(await inFlight).toEqual({ done: true })
    await done
    expect(order).toEqual(['kafka', 'database'])
    expect(exitCode).toBe(0)
    await expect(fetch(`${base}/health/live`)).rejects.toThrow('fetch failed')
  })

  it('runs only once, and keeps going if a closer fails', async () => {
    const health = createHealth({ started: true })
    const server = createBaseApp({ name: 'svc', logger, health }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const order: string[] = []
    const exits: number[] = []
    const shutdown = handleShutdown({
      logger,
      server,
      health,
      drainDelayMs: 0,
      registerProcessHandlers: false,
      exit: (code) => void exits.push(code),
      closers: [
        { name: 'broken', close: () => Promise.reject(new Error('boom')) },
        { name: 'database', close: async () => void order.push('database') },
      ],
    })
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')])
    expect(order).toEqual(['database'])
    expect(exits).toEqual([0])
  })

  it('forces exit(1) when a closer hangs past the timeout', async () => {
    const health = createHealth({ started: true })
    const server = createBaseApp({ name: 'svc', logger, health }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const exits: number[] = []
    void handleShutdown({
      logger,
      server,
      health,
      drainDelayMs: 0,
      timeoutMs: 200,
      registerProcessHandlers: false,
      exit: (code) => void exits.push(code),
      closers: [{ name: 'stuck', close: () => new Promise(() => {}) }],
    })('test')
    await sleep(400)
    expect(exits).toEqual([1])
  })
})
