# Simulated retailer: storefront

The simulated retailer's web shop, a React + Vite app. It stands in for a retailer's site (a Flipkart or a Walmart) that integrates [Basketline](../../README.md):

- **Store:** a catalog and campaign carousel from the API, product pages and a cart, for visitors and signed-in shoppers.
- **Sign-in:** optional, against the auth service.
- **Analytics events:** sent to Basketline through its SDK as shoppers browse.

## Quick start

Requirements: Node.js 20.19+ (developed on Node 24) and pnpm (`corepack enable pnpm`), with the platform (`../../basketline/README.md`) and the retailer's services (`../README.md`) running locally. Dependencies are installed once for the whole repo, from its root (`pnpm install`).

```bash
cd retailer-sim/storefront
cp .env.example .env         # points at the gateway on http://localhost:8080/api/v1
pnpm dev                     # http://localhost:5174
```

**The SDK:** the storefront sends its events through [`@divya2424/basketline-sdk`](https://github.com/divya2424/basketline-sdk), the same package vendors install. It's on GitHub Packages, which needs a token even to install: a classic personal access token with `read:packages`, in `NODE_AUTH_TOKEN`, and once, in `~/.npmrc`: `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (pnpm takes registry tokens only from your user config). To use a new SDK version, publish it from its repo, then `pnpm add @divya2424/basketline-sdk@<version>` here. `src/analytics/sdkContract.test.js` checks that its event names match the API's.

Open a tenant's store from the Basketline dashboard (http://localhost:5173, **Open store** on its row), or go to http://localhost:5174 for the default tenant.

| Command | |
|---|---|
| `pnpm dev` | Development server on http://localhost:5174 (the gateway allows CORS from here) |
| `pnpm test` | Vitest + React Testing Library. No backend needed |
| `pnpm build` | Production build into `dist/` |

## Configuration

Set these in `.env`, starting from `.env.example`.

| Variable | Values | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | URL | The API gateway, e.g. `http://localhost:8080/api/v1`. Every API call goes here, and analytics events are only sent when it's set. |
| `VITE_TENANT_ID` | UUID | The default tenant, sent as the `tenant_id` header. Defaults to `5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01`. A tenant opened from the dashboard takes precedence. |

## Using the store

- **Which store:** the dashboard's **Open store** link names the tenant (`/store?tenant=<id>&name=<name>`). It's remembered in `localStorage` (`basketline:tenant`), and each store has its own cart.
- **Pages:** `/store`, `/store/products/:id` and `/cart`, open to visitors.
- **Header:** the store's name, Home, **Log in** (or the user and **Logout** when signed in) and the cart.
- **Session:** kept in `sessionStorage` (`basketline:session:v3`: profile, role, token and expiry, tenant; never the password), so it lasts until the tab closes. The token lasts 30 minutes, then the store signs out; Logout ends the session on the server too. A session belongs to one store: switching stores means signing in again.

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

**Sending to Basketline.** When `VITE_API_BASE_URL` is set, events are batched to `POST /analytics/events` (`src/analytics/backendTransport.js`). The campaign metrics count:

| Shopper action | Sent as |
|---|---|
| A campaign's slide becomes visible | `impression` (instead of `campaign_impression`) |
| A campaign card in the carousel is clicked | `click`, with its product |
| Add to cart | `add_to_cart`, with its product. Basketline credits it to an earlier ad click; the browser keeps no record of clicks. |

Add to cart is never an ad click itself, even on a campaign card. Sending never blocks or breaks shopping: failures are logged and dropped.

**Who sent them.** Each batch carries `tenantId`, `userId` and `userType`:

| | `userId` | `userType` | Token |
|---|---|---|---|
| Signed in | the user's ID | `registered` | the user's access token |
| Visitor | this browser's UUID for the store (localStorage `basketline:anonymous-id:<tenant>`, or one per page if storage is blocked) | `visitor` | a visitor token for that UUID (`POST /auth/visitor`, `clientType: web`) |

Basketline rejects a batch whose identity doesn't match its token.

## How it talks to the backend

Every request goes through `apiRequest()` (`src/api/httpClient.js`), one [axios](https://axios-http.com) instance using the fetch adapter, so events can use `keepalive`. It:
- adds the `tenant_id` header, plus `user_id` and `Authorization: Bearer <token>` when signed in;
- parses JSON;
- turns `{ error: { code, message } }` responses into an `ApiError`;
- signs the user out when a signed-in request gets a 401 (an expired or revoked session).

| Feature | API calls |
|---|---|
| Catalog | `GET /products?limit=100` and `GET /campaigns?status=active&limit=100`, once per page load. Public, so visitors can browse signed out. |
| Sign-in | `POST /auth/login` (`clientType: "web"`), `POST /auth/logout` |
| Events | `POST /auth/visitor`, `POST /analytics/events` |

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
  pages/HomePage.jsx
```

**Testing:** the tests render the app with the sample catalog, and `mockFetch()` (`src/test/mockFetch.js`) answers API calls, so they need no backend. `productData.js` and `campaignData.js` are only test fixtures and the source of `pnpm seed` (in `basketline/`); the app itself loads everything from the API.

**StrictMode:** in development, React mounts each component twice. Pending data requests are shared (`src/api/sharedRequest.js`) rather than cancelled on unmount, so each is sent once.
