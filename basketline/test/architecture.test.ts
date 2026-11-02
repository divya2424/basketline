import { describe, expect, it } from 'vitest'
import { findViolations, scanSource } from '../scripts/check-architecture.ts'

describe('architecture rules', () => {
  it('holds for the current code base', () => {
    expect(findViolations()).toEqual([])
  })

  it('flags HTTP calls from services other than the gateway', () => {
    expect(scanSource('campaign-service', 'x.ts', "await fetch('http://product-service/api')")).toHaveLength(1)
    expect(scanSource('ingestion-service', 'x.ts', "import axios from 'axios'")).toHaveLength(1)
    expect(scanSource('gateway', 'x.ts', "import { createProxyMiddleware } from 'http-proxy-middleware'")).toEqual([])
  })

  it('flags imports of another service’s code', () => {
    expect(scanSource('campaign-service', 'x.ts', "import { x } from '../../../services/product-service/src/app.ts'")).toHaveLength(1)
    expect(scanSource('campaign-service', 'x.ts', "import { x } from '@basketline/platform'")).toEqual([])
  })

  it("flags the simulated retailer using Basketline's own Kafka topics", () => {
    expect(scanSource('product-service', 'x.ts', "import { TOPICS } from '@basketline/contracts'")).toHaveLength(1)
    expect(scanSource('campaign-service', 'x.ts', "const topic = 'auth.tenant.v1'")).toHaveLength(1)
    expect(scanSource('campaign-service', 'x.ts', "import { RETAILER_TOPICS } from '@retailer-sim/shared'")).toEqual([])
    expect(scanSource('ingestion-service', 'x.ts', "import { TOPICS } from '@basketline/contracts'")).toEqual([])
  })
})
