import { API_BASE_URL } from '../../api/httpClient.js'
import { CopyField } from './KeyReveal.jsx'

/** The API this dashboard talks to, as an absolute URL: the one a vendor's site must call too. */
const dashboardApiUrl = () => new URL(API_BASE_URL || '/', window.location.href).href.replace(/\/+$/, '')

/** The few lines a vendor adds to their site, with their store's tenant ID and the API filled in. */
export function SdkSnippet({ tenantId, apiUrl = dashboardApiUrl() }) {
  const code = `import { createBasketline } from '@divya2424/basketline-sdk'

const bl = createBasketline({
  apiUrl: '${apiUrl}',
  tenantId: '${tenantId}',
})

bl.sendEvent('impression', { campaignId })             // an ad was seen
bl.sendEvent('click', { campaignId, productId })       // an ad was clicked
bl.sendEvent('add_to_cart', { productId, quantity: 1 }) // credited to that click
bl.sendEvent('cart_view', { pageName: 'cart' })        // anything else`
  return (
    <div className="sdk-snippet">
      <CopyField label="Tenant ID" value={tenantId} testId="integration-tenant-id" />
      <pre className="sdk-snippet__code" aria-label="SDK setup code">
        <code>{code}</code>
      </pre>
      <p className="small muted">
        Install with <code>npm install @divya2424/basketline-sdk</code> (from GitHub Packages). Signed-in shoppers: your
        backend exchanges an API key for a shopper token (see the{' '}
        <a href="https://github.com/divya2424/basketline-sdk#readme" target="_blank" rel="noreferrer">
          SDK guide
        </a>
        ).
      </p>
    </div>
  )
}
