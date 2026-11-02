import { Router } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { badRequest, createBaseApp, createHealth, createLogger, errorHandler, notFoundHandler } from '../src/index.ts'

const logger = createLogger('metrics-test')

function app() {
  const base = createBaseApp({ name: 'svc', logger, health: createHealth({ started: true }) })
  const router = Router()
  router.get('/:campaignId/:metric', (req, res) => {
    if (req.params.metric === 'unknown') throw badRequest('UNKNOWN_METRIC', 'no such metric')
    res.status(req.params.metric === 'broken' ? 500 : 200).json({})
  })
  base.use('/api/v1/ad', router)
  base.use(notFoundHandler)
  base.use(errorHandler)
  return base
}

describe('GET /metrics', () => {
  it('counts requests by route pattern and status, with their latency, leaving out probes', async () => {
    const svc = app()
    await request(svc).get('/api/v1/ad/11111111-1111-4111-8111-111111111111/clicks')
    await request(svc).get('/api/v1/ad/22222222-2222-4222-8222-222222222222/clicks')
    await request(svc).get('/api/v1/ad/22222222-2222-4222-8222-222222222222/broken')
    // A thrown error is answered by the app's error handler, still under its route.
    await request(svc).get('/api/v1/ad/22222222-2222-4222-8222-222222222222/unknown')
    await request(svc).get('/nowhere')
    await request(svc).get('/health/ready')

    const res = await request(svc).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    const count = (labels: string) =>
      Number(res.text.match(new RegExp(`^http_request_duration_seconds_count\\{${labels}\\} (\\d+)$`, 'm'))?.[1] ?? 0)
    // One series per route pattern, not per campaign ID.
    expect(count('service="svc",method="GET",route="/api/v1/ad/:campaignId/:metric",status_code="200"')).toBe(2)
    expect(count('service="svc",method="GET",route="/api/v1/ad/:campaignId/:metric",status_code="500"')).toBe(1)
    expect(count('service="svc",method="GET",route="/api/v1/ad/:campaignId/:metric",status_code="400"')).toBe(1)
    expect(count('service="svc",method="GET",route="unmatched",status_code="404"')).toBe(1)
    expect(res.text).not.toMatch(/route="\/health/)
    expect(res.text).not.toMatch(/11111111-1111/)
    // Node's process metrics too.
    expect(res.text).toMatch(/^nodejs_eventloop_lag_seconds\{service="svc"\} /m)
  })
})
