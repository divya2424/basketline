# @basketline/sdk

Send ad and shopper events from your website to [Basketline](../README.md), and see impressions, clicks, click-to-basket, unique customers and sessions for every campaign on your Basketline dashboard.

- **Small:** about 6 KB minified, no dependencies.
- **Safe for your page:** it never throws into it. Problems go to `onError`.
- **Batched:** 20 events per request or every 2 s, and sent when the page is hidden, so nothing is lost on navigation.
- **Attribution included:** you send what happened (`click`, `addToCart`), and Basketline credits each add to cart to the shopper's latest ad click on that product within 7 days.

## Install

```bash
npm install @basketline/sdk
```

```js
import { createBasketline } from '@basketline/sdk'
```

Or with a script tag, without a bundler:

```html
<script src="https://cdn.jsdelivr.net/npm/@basketline/sdk@0.1.0/dist/basketline.global.js"></script>
<script>
  const bl = Basketline.createBasketline({ apiUrl: 'https://api.basketline.io/api/v1', tenantId: 'YOUR-TENANT-ID' })
</script>
```

## Quick start

```js
const bl = createBasketline({
  apiUrl: 'https://api.basketline.io/api/v1',   // locally: http://localhost:8080/api/v1
  tenantId: 'YOUR-TENANT-ID',                   // your store's ID, from Basketline
})

// An ad was shown.
bl.impression({ campaignId })

// The shopper clicked the ad, opening a product.
bl.click({ campaignId, productId })

// The shopper added a product to the cart (anywhere on your site, any time in the next 7 days).
bl.addToCart({ productId, quantity: 1 })

// Anything else you want to analyse later.
bl.track('cart_view', { pageName: 'cart' })
```

That's all a visitor needs. The SDK:
1. gives the browser a lasting visitor ID for your store;
2. gets a visitor token for it from Basketline;
3. sends the events with that token.

| Method | Sends | Required |
|---|---|---|
| `impression({ campaignId, … })` | `impression` | `campaignId` |
| `click({ campaignId, productId, … })` | `click` | `campaignId`; `productId` for click-to-basket |
| `addToCart({ productId, quantity?, … })` | `add_to_cart` | `productId` |
| `track(eventName, { campaignId?, productId?, pageName?, featureName?, properties? })` | any event in `EVENT_NAMES` | `campaignId` for `impression` and `click` |

IDs are UUIDs. Every method returns the event's ID, or `null` if the event was invalid; the reason goes to `onError`. `properties` holds anything else useful. Keys that look like personal data (email, phone, address, names, card numbers, …) are dropped before sending.

## Signed-in shoppers

When a shopper signs in to your site, tell the SDK who they are. Their activity then counts as a registered customer's, across devices. Basketline never sees your users' passwords or personal data. Your **backend** vouches for the shopper with your **secret API key**:

```
 browser (SDK)                     your backend                         Basketline
 ─────────────                     ────────────                         ──────────
 bl.visitorId ───── sign-in ─────► POST /auth/shopper-token  ─────────► checks the API key
                                    Authorization: ApiKey bl_sk_…        maps your customer ID
                                    tenant_id: YOUR-TENANT-ID            to one Basketline user ID
                                    { customerId, visitorId }   ◄─────── { shopperToken, userId }
 bl.identify({ userId, getToken }) ◄── { userId, token }
```

**1. Your backend** gets a shopper token. Keep the API key on the server; never put it in the page.

```ts
// See examples/backend-token.ts for an Express handler.
const res = await fetch('https://api.basketline.io/api/v1/auth/shopper-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', tenant_id: TENANT_ID, Authorization: `ApiKey ${process.env.BASKETLINE_API_KEY}` },
  body: JSON.stringify({ customerId: currentUser.id, visitorId: req.body.visitorId }),
})
const { shopperToken, userId } = await res.json()   // the token lasts 30 minutes
```

**2. The page** passes it to the SDK:

```js
const { userId } = await fetch('/api/basketline-token', { method: 'POST', body: JSON.stringify({ visitorId: bl.visitorId }) }).then((r) => r.json())
bl.identify({
  userId,
  // Called whenever the SDK needs a token: now, before it expires, and after a 401.
  getToken: () => fetch('/api/basketline-token', { method: 'POST' }).then((r) => r.json()).then((b) => b.token),
})

// On sign-out:
bl.reset()
```

**Why `visitorId`:** the first time a customer gets a token, Basketline gives them the browser's visitor ID. Their visits from before they signed in then count as the same person. Later calls return the same `userId`, whatever `visitorId` comes with them.

**API keys:** every store gets its first key when it's onboarded, shown once on the onboarding page. Campaign managers create and revoke keys in the dashboard, under **Integrate your site**. Or locally, with the CLI:

```bash
docker compose exec auth-service node services/auth-service/src/cli.ts create-api-key --tenant <tenant-id> --name 'Production web'
```

The key is shown once. `list-api-keys` and `revoke-api-key --prefix bl_sk_…` manage them. A shopper token can only send events; no other Basketline API accepts it.

## Options

| Option | Default | |
|---|---|---|
| `apiUrl` | — | The Basketline API, e.g. `https://api.basketline.io/api/v1` |
| `tenantId` | — | Your store's tenant ID |
| `clientType` | `'web'` | `'web'` or `'mobile'`; the dashboard splits every metric by it |
| `batchSize` | `20` | Events per request (at most 100) |
| `flushAfterMs` | `2000` | How long the first queued event waits for others |
| `storage` | `localStorage` | Where the visitor ID is kept (`getItem`/`setItem`). Without storage, the ID lasts for the page |
| `onError` | `console.warn` | `(error: BasketlineError) => void`: invalid events, dropped properties, failed requests |
| `debug` | `false` | Logs every event and request |
| `fetch` | `globalThis.fetch` | For tests or unusual runtimes |

`bl.flush()` sends what's queued now and resolves when it's done. `bl.visitorId` is the browser's visitor ID for your store.

## Delivery

- **Retries:**
  - a `401` fetches a fresh token once;
  - a `429` or `5xx` is retried once, after `Retry-After`;
  - anything else goes to `onError`.
- **Order:** batches go out in order, so a shopper's events never overtake each other.
- **Across identities:** events queued before `identify()` or `reset()` go out under the identity they were tracked with.
- **Rate limits** (per IP, at the gateway):
  - 120 event requests a minute;
  - 10 visitor tokens a minute;
  - 300 events per sender a minute.
- **CORS:** the SDK's endpoints (`/auth/visitor`, `/analytics/events`) accept requests from any origin, so it works on your domain without setup.

## Develop and publish

```bash
npm install
npm test             # Vitest + jsdom
npm run typecheck
npm run build        # dist/: ESM, CommonJS, basketline.global.js (window.Basketline), .d.ts
npm pack             # basketline-sdk-0.1.0.tgz, to try in another project
npm publish --access public   # needs the @basketline scope on npm; runs typecheck, tests and build first
```

**Keeping in step with the API:**
- the event names must match the API's; `test/events.test.ts` checks them against `backend/packages/contracts`;
- Basketline's own storefront (`frontend/`) sends its events through this package, so its tests exercise it too.
