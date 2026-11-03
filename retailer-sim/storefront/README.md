# Simulated retailer: storefront

The simulated retailer's web shop, a React + Vite app. It stands in for a retailer's site (a Flipkart or a Walmart) that integrates [Basketline](../../README.md):

- **Store:** the catalog and a campaign carousel per placement (the marketplace's sections: Spotlight, Top rated, …) from the retailer's own services, product pages and a cart, for visitors and signed-in customers.
- **Seller portal** (`/seller`, signed in as a seller, e.g. `seller1`): the seller's campaigns of its own products, each in a placement; create, pause and resume them, add and remove products, and open each one's analytics page (`/seller/campaigns/:id`): headline numbers, the funnel from impression to add-to-cart, web vs mobile, and every product's results, over 7, 30 or 90 days, which campaign-service reads from Basketline.
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

Add a marketplace at http://localhost:5174, then **Visit** it: sign in as one of its sellers (the seller portal) or shoppers, or browse as a visitor.

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
| `VITE_TENANT_ID` | UUID | The default store's tenant, sent as the `tenant_id` header. Defaults to `5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01`. A marketplace visited from the Marketplaces page takes precedence. |
| `VITE_API_BASE_URL` | URL | The retailer's services. Defaults to `/api/v1` on this origin, which the dev and preview servers proxy (`vite.config.js`): products and sellers to 4002, campaigns and placements to 4003, auth and stores to 4006. |

## Using the store

- **Which marketplace:** **Visit** on the Marketplaces page (`/`) opens its page (`/m/:tenantId`), signing out of the previous one. It's remembered in `localStorage` (`basketline:tenant`), and each has its own cart.
- **A marketplace's page:** **Sell** lists its sellers (by name, from `GET /sellers`) and **Shop** its shoppers (`GET /stores/:tenantId/logins`, demo only); picking one signs in with the username fixed and the demo password filled in, then opens the seller portal (`/seller`) or the shop (`/store`). **Browse as a visitor** opens the shop signed out.
- **Adding a marketplace:** the Marketplaces page's form (name, Basketline tier) calls `POST /stores`. The retailer's auth service onboards the store at Basketline (`POST /accounts`), keeps its API key, creates the store's logins (`staff`, `user01`–`user10`, `seller1`, `seller2`, password `test`) and seeds its sellers, products, placements and campaigns, which its services send to Basketline. The page shows the logins.
- **Pages:** `/` (Marketplaces), `/m/:tenantId`, `/store`, `/store/products/:id` and `/cart`, open to visitors; `/seller` for sellers.
- **Header:** the marketplace's name (to its page), Marketplaces, Shop, Seller portal (for sellers), **Log in** (or the user and **Logout** when signed in) and the cart.
- **Session:** kept in `sessionStorage` (`retailer:session:v1`: profile, role, the store's token and expiry, a customer's Basketline shopper token, tenant; never the password), so it lasts until the tab closes. The token lasts 30 minutes, then the store signs out. The store's tokens aren't kept server-side, so Logout just forgets them. A session belongs to one store: switching stores means signing in again.

> **Security note:** any script on the page can read `sessionStorage`, so the app must stay free of XSS. An `httpOnly` cookie would avoid this, but needs backend support.

## Analytics events

Components call `trackEvent()` (or `track()` from `useAnalytics()` inside an `<AnalyticsWrapper>`). Every event is also kept in the browser: run `__basketline.getEvents()` in the console.

| Event | Emitted when |
|---|---|
| `home_view` | Once per home page visit |
| `campaign_impression` | A carousel slide is at least 50% visible: one per product on it, with its campaign and the campaign's seller (`storeId`) |
| `campaign_navigation` | The user changes slide |
| `product_click` | A product card is clicked, opening the product page |
| `add_to_cart` | Add to cart on a catalog card (`source: catalog_grid`) or the product page (`featureName: product_detail`) |
| `cart_view`, `cart_quantity_update`, `remove_from_cart` | Cart page activity |
| `login_click` | The sign-in dialog opens |

**Sending to Basketline.** When `VITE_BASKETLINE_API_URL` is set, the SDK batches events to Basketline's `POST /analytics/events` (`src/analytics/backendTransport.js`). The campaign metrics count:

| Shopper action | Sent as |
|---|---|
| A campaign's product is shown (its slide becomes visible) | `impression` (instead of `campaign_impression`), with the product |
| A campaign card in the carousel is clicked | `click`, with its product |
| Add to cart | `add_to_cart`, with its product. Basketline credits it to an earlier ad click; the browser keeps no record of clicks. |

Impressions, clicks and add-to-carts carry the product's seller as their `storeId`: at Basketline a seller is a store, so its results are its own. Add to cart is never an ad click itself, even on a campaign card. Sending never blocks or breaks shopping: failures are logged and dropped.

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
| Catalog | `GET /products?limit=100`, `GET /campaigns?status=active&limit=100` and `GET /placements`, once per page load. Public, so visitors can browse signed out. |
| Sign-in | `POST /auth/login` (`clientType: "web"`, the SDK's `visitorId`), `POST /auth/shopper-token` |
| Stores | `GET /stores`, `POST /stores` |

Events go to Basketline through the SDK only (`POST /auth/visitor`, `POST /analytics/events`).

The store loads up to 100 products and 100 campaigns, so no pagination is needed. The home page has one carousel per active placement with campaigns, in the placements' order (`sectionsByPlacement()`), and each carousel (`buildCarouselItems()` in `src/features/campaigns/carouselItems.js`):
- interleaves its campaigns' products (the 1st of each, then the 2nd, …) in slides of 3, so every seller in the placement is seen;
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
  features/campaigns/ CampaignCarousel (one per placement); campaignData.js = sample placements and campaigns
  features/seller/    the seller portal: its campaigns, and each one's analytics page
  features/cart/      CartContext, CartPage (saved in localStorage: basketline:cart:v2)
  features/auth/      sign-in, session, LoginModal
  features/stores/    StoresPage: connect a store to Basketline, open one
  pages/HomePage.jsx
```

**Testing:** the tests render the app with the sample catalog, and `mockFetch()` (`src/test/mockFetch.js`) answers API calls, so they need no backend. `productData.js` and `campaignData.js` are only test fixtures; the app itself loads everything from the API.

**StrictMode:** in development, React mounts each component twice. Pending data requests are shared (`src/api/sharedRequest.js`) rather than cancelled on unmount, so each is sent once.
