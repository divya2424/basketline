import { describe, expect, it } from 'vitest'
import { findViolations, scanSource } from '../scripts/check-architecture.ts'

describe('architecture rules', () => {
  it('holds for the current code base', () => {
    expect(findViolations()).toEqual([])
  })

  it('flags HTTP calls from services other than the gateway', () => {
    expect(scanSource('campaign-service', 'x.ts', "await fetch('http://product-service/api')")).toHaveLength(1)
    expect(scanSource('analytics-service', 'x.ts', "import axios from 'axios'")).toHaveLength(1)
    expect(scanSource('gateway', 'x.ts', "import { createProxyMiddleware } from 'http-proxy-middleware'")).toEqual([])
  })

  it('flags imports of another service’s code', () => {
    expect(scanSource('campaign-service', 'x.ts', "import { x } from '../../../services/product-service/src/app.ts'")).toHaveLength(1)
    expect(scanSource('campaign-service', 'x.ts', "import { x } from '@ecommerce-analytics/platform'")).toEqual([])
  })
})
