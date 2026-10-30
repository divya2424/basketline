import { CopyField } from './KeyReveal.jsx'

/** The few lines a vendor adds to their site, with their store's tenant ID filled in. */
export function SdkSnippet({ tenantId, apiUrl = import.meta.env.VITE_API_BASE_URL || 'https://api.basketline.io/api/v1' }) {
  const code = `import { createBasketline } from '@divya2424/basketline-sdk'

const bl = createBasketline({
  apiUrl: '${apiUrl}',
  tenantId: '${tenantId}',
})

bl.impression({ campaignId })        // an ad was seen
bl.click({ campaignId, productId })  // an ad was clicked
bl.addToCart({ productId })          // credited to that click`
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
