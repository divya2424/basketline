# Simulated retailer: storefront

The simulated retailer's web shop, a React + Vite app. It stands in for a retailer's site (a Flipkart or a Walmart) that integrates [Basketline](../../README.md):

- **Store:** a catalog and campaign carousel from the retailer's own services, product pages and a cart, for visitors and signed-in customers.
- **Sign-in:** optional, against the retailer's own auth service (`retailer-auth-service`), not Basketline's.
- **Stores:** `/stores` connects a new store to Basketline (the retailer's backend onboards it with Basketline's API and keeps its API key) and opens existing ones.
- **Analytics events:** sent to Basketline through its SDK as shoppers browse. The SDK is the only way this site talks to Basketline.

## Quick start

Requirements: Node.js 20.19+ (developed on Node 24) and pnpm (`corepack enable pnpm`), with the platform (`../../basketline/README.md`) and the retailer's services (`../README.md`) running locally. Dependencies are installed once for the whole repo, from its root (`pnpm install`).

```bash
cd retailer-sim/storefront
cp .env.example .env         # Basketline's gateway (for the SDK) on http://localhost:8080/api/v1
pnpm dev                     # http://localhost:5174; /api/v1 is proxied to the retailer's services
```

**The SDK:** the storefront sends its events through [`@divya2424/basketline-sdk`](https://github.com/divya2424/basketline-sdk), the same package vendors install. It's on GitHub Packages, which needs a token even to install: a classic personal access token with `read:packages`, in `NODE_AUTH_TOKEN`, and once, in `~/.npmrc`: `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (pnpm takes registry tokens only from your user config). To use a new SDK version, publish it from its repo, then `pnpm add @divya2424/basketline-sdk@<version>` here. `src/analytics/sdkContract.test.js` checks that its event names match the API's.

Connect a store at http://localhost:5174/stores, then **Open** it. The dashboard's **Open store** link (http://localhost:5173) opens one too.

| Command | |
|---|---|
| `pnpm dev` | Development server on http://localhost:5174 (Basketline's gateway allows CORS from here, for the SDK) |
| `pnpm test` | Vitest + React Testing Library. No backend needed |
| `pnpm build` | Production build into `dist/` |

## Configuration

Set these in `.env`, starting from `.env.example`.

| Variable | Values | Purpose |
|---|---|---|
| `VITE_BASKETLINE_API_URL` | URL | Basketline's gateway, e.g. `http://localhost:8080/api/v1`, used only by the SDK. Analytics events are only sent when it's set. |
| `VITE_TENANT_ID` | UUID | The default store's tenant, sent as the `tenant_id` header. Defaults to `5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01`. A store opened from the Stores page or the dashboard takes precedence. |
| `VITE_API_BASE_URL` | URL | The retailer's services. Defaults to `/api/v1` on this origin, which the dev and preview servers proxy (`vite.config.js`): products and sellers to 4002, campaigns to 4003, auth and stores to 4006. |
| `VITE_DASHBOARD_URL` | URL | The Basketline dashboard, linked after connecting a store. Defaults to `http://localhost:5173`. |

## Using the store

- **Which store:** **Open** on the Stores page, or the dashboard's **Open store** link (`/store?tenant=<id>&name=<name>`). It's remembered in `localStorage` (`basketline:tenant`), and each store has its own cart.
- **Connecting a store:** the Stores page's form (name, Basketline tier) calls `POST /stores`. The retailer's auth service onboards the store at Basketline (`POST /accounts`), keeps its API key, creates the store's logins (`staff`, `user01`–`user10`, password `test`) and seeds its sellers, products and campaigns, which its services send to Basketline. The page shows the logins, including the Basketline dashboard's (`seller01` is a seller manager for the first seller).
- **Pages:** `/store`, `/store/products/:id`, `/cart` and `/stores`, open to visitors.
- **Header:** the store's name, Home, Stores, **Log in** (or the user and **Logout** when signed in) and the cart.
- **Session:** kept in `sessionStorage` (`retailer:session:v1`: profile, role, the store's token and expiry, a customer's Basketline shopper token, tenant; never the password), so it lasts until the tab closes. The token lasts 30 minutes, then the store signs out. The store's tokens aren't kept server-side, so Logout just forgets them. A session belongs to one store: switching stores means signing in again.

> **Security note:** any script on the page can read `sessionStorage`, so the app must stay free of XSS. An `httpOnly` cookie would avoid this, but needs backend support.

## Analytics events

Components call `trackEvent()` (or `track()` from `useAnalytics()` inside an `<AnalyticsWrapper>`). Every event is also kept in the browser: run `__basketline.getEvents()` in the console.

| Event | Emitted when |
|---|---|
| `home_view` | Once per home page visit |
| `campaign_impression` | A carousel slide is at least 50% visible (one per campaign on it) |
| `campaign_navigation` | The user changes slide |
| `product_click` | A product card is clicked, opening the product page |
| `add_to_cart` | Add to cart on a catalog card (`source: catalog_grid`) or the product page (`featureName: product_detail`) |
| `cart_view`, `cart_quantity_update`, `remove_from_cart` | Cart page activity |
| `login_click` | The sign-in dialog opens |

**Sending to Basketline.** When `VITE_BASKETLINE_API_URL` is set, the SDK batches events to Basketline's `POST /analytics/events` (`src/analytics/backendTransport.js`). The campaign metrics count:

| Shopper action | Sent as |
|---|---|
| A campaign's slide becomes visible | `impression` (instead of `campaign_impression`) |
| A campaign card in the carousel is clicked | `click`, with its product |
| Add to cart | `add_to_cart`, with its product. Basketline credits it to an earlier ad click; the browser keeps no record of clicks. |

Add to cart is never an ad click itself, even on a campaign card. Sending never blocks or breaks shopping: failures are logged and dropped.

**Who sent them.** Each batch carries `tenantId`, `userId` and `userType`:

| | `userId` | `userType` | Token |
|---|---|---|---|
| Signed-in customer | Basketline's ID for the customer | `registered` | a shopper token: at sign-in, the store's auth service exchanges its API key for one (Basketline `POST /auth/shopper-token`, with the customer's ID and this browser's visitor ID); the SDK renews it through the store's `POST /auth/shopper-token` |
| Visitor (and staff) | this browser's UUID for the store (localStorage `basketline:anonymous-id:<tenant>`, or one per page if storage is blocked) | `visitor` | a visitor token for that UUID (Basketline `POST /auth/visitor`, `clientType: web`) |

Basketline rejects a batch whose identity doesn't match its token. If Basketline is down at sign-in, the customer still signs in, and their events go as the visitor.

## How it talks to the backend

Every request to the retailer's services goes through `apiRequest()` (`src/api/httpClient.js`), one [axios](https://axios-http.com) instance using the fetch adapter. It:
- adds the `tenant_id` header, plus `user_id` and `Authorization: Bearer <token>` when signed in;
- parses JSON;
- turns `{ error: { code, message } }` responses into an `ApiError`;
- signs the user out when a signed-in request gets a 401 (an expired or revoked session).

| Feature | API calls |
|---|---|
| Catalog | `GET /products?limit=100` and `GET /campaigns?status=active&limit=100`, once per page load. Public, so visitors can browse signed out. |
| Sign-in | `POST /auth/login` (`clientType: "web"`, the SDK's `visitorId`), `POST /auth/shopper-token` |
| Stores | `GET /stores`, `POST /stores` |

Events go to Basketline through the SDK only (`POST /auth/visitor`, `POST /analytics/events`).

The store loads up to 100 products and 100 campaigns, so no pagination is needed. The carousel (`buildCarouselItems()` in `src/features/campaigns/carouselItems.js`):
- interleaves the active campaigns' products (the 1st of each, then the 2nd, …) in slides of 3;
- tags each card with its campaign;
- shows a product listed in several campaigns once.

## Project layout

```
src/
  api/                httpClient (apiRequest, ApiError), requestContext (tenant, user, token)
  app/                app shell and routes
  analytics/          trackEvent, event schema, transports (local + Basketline SDK)
  components/         layout (Header, Footer) and common (Button, Toast, Spinner, AnalyticsWrapper)
  features/catalog/   CatalogProvider: products + active campaigns from the API
  features/products/  ProductCard, ProductGrid; productData.js = sample data
  features/campaigns/ CampaignCarousel; campaignData.js = sample data
  features/cart/      CartContext, CartPage (saved in localStorage: basketline:cart:v2)
  features/auth/      sign-in, session, LoginModal
  features/stores/    StoresPage: connect a store to Basketline, open one
  pages/HomePage.jsx
```

**Testing:** the tests render the app with the sample catalog, and `mockFetch()` (`src/test/mockFetch.js`) answers API calls, so they need no backend. `productData.js` and `campaignData.js` are only test fixtures; the app itself loads everything from the API.

**StrictMode:** in development, React mounts each component twice. Pending data requests are shared (`src/api/sharedRequest.js`) rather than cancelled on unmount, so each is sent once.
