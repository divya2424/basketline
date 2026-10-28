# ShopSphere — Storefront & Campaign Analytics (frontend)

A React + Vite storefront connected to the ShopSphere backend (`../backend`). It includes:
- a product catalog and campaign carousel loaded from the API;
- a shopping cart;
- sign-in against the auth service;
- analytics events sent to the analytics service;
- a campaign analytics dashboard for campaign managers.

## Requirements

- Node.js 20.19+ (developed on Node 24) and npm
- The backend running locally. See `../backend/README.md`; the short version is below.

## Setup and run

```bash
# 1. Backend: start everything, create a campaign manager, load the sample catalog
cd backend
npm install && npm run keys
docker compose up -d --build
docker compose exec auth-service node services/auth-service/src/cli.ts \
  create-account --name 'Default storefront' --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
docker compose exec auth-service node services/auth-service/src/cli.ts \
  create-user --username maya --password 'correct horse battery' --role campaign-manager \
  --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01   # VITE_TENANT_ID; all data is per tenant
npm run seed                 # the 10 sample products and 4 campaigns, in that tenant

# 2. Frontend
cd ../frontend
npm install
cp .env.example .env         # points at the gateway on http://localhost:8080/api/v1
npm run dev                  # http://localhost:5173 (the gateway allows CORS from here)
```

Sign in as `maya` / `correct horse battery` to see **Analytics**. Anyone can register a standard (shopper) account with `POST /api/v1/auth/register`.

Other commands:

```bash
npm test                     # Vitest + React Testing Library (no backend needed)
npm run build                # production build into dist/
```

## Configuration

| Variable | Values | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | URL | The API gateway, e.g. `http://localhost:8080/api/v1`. Every API call goes here, and analytics events are only sent when it's set. |
| `VITE_ANALYTICS_MODE` | `live` \| `mock` | `live` reads dashboard metrics from the API. `mock` shows demo numbers (labelled **Mock data**) for any campaign. |
| `VITE_TENANT_ID` | UUID | The storefront's tenant, sent as the `tenant_id` header: accounts registered here and visitor tokens (which anonymous visitors' analytics events are sent with) belong to it. Defaults to `5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01`. |

## How it talks to the backend

Every request goes through `apiRequest()` in `src/api/httpClient.js`, which uses one [axios](https://axios-http.com) instance (`http`, with the fetch adapter so events can use `keepalive`). It:
- adds `tenant_id` (through a request interceptor), plus `user_id` and `Authorization: Bearer <token>` when signed in;
- parses JSON responses;
- turns `{ error: { code, message } }` responses into an `ApiError`;
- signs the user out when a signed-in request gets a 401, meaning the token expired or the session was revoked.

| Feature | API calls |
|---|---|
| Catalog (`src/features/catalog`) | `GET /products?limit=100` and `GET /campaigns?status=active&limit=100`, once per page load. These reads are public, so visitors can browse without signing in. The home page shows a loader while they load, and an error with **Try again** if they fail. |
| Sign-in (`src/features/auth`) | `POST /auth/login` (`clientType: "web"`) and `POST /auth/logout`. |
| Dashboard (`src/features/analytics`) | `GET /ad/{campaignId}/clicks \| impressions \| clickToBasket?from&to` for the active campaigns, over the chosen time range. |
| Analytics events (`src/analytics/backendTransport.js`) | `POST /analytics/events` |

## Onboarding tenants (the home page)

The app opens on the onboarding page (`/`), open to everyone (no sign-in). A tenant's application, its store (`/store`), product pages (`/store/products/:id`), cart (`/cart`) and dashboard (`/analytics`), appears only after signing in to that tenant from its row; signed out, those pages redirect to `/`.
- **Onboard a tenant:** a name, a tier (Free, Pro, Enterprise) and "Create 10 demo users". The backend generates the tenant ID and creates an `onboarding` campaign manager, plus `user01`–`user10` (standard users) when ticked. **Every one of them has the password `test`.** The tenant is also seeded with 10–15 sample products (a random number) and 2 active campaigns of 2 and 3 of them (picked at random), which appear in its store within a few seconds.
- **Tenants:** every onboarded tenant, newest first, with its tier and ID. Each row has three buttons:
  - **Open store** and **Analytics** switch the app to that tenant, sign in as its `onboarding` user, and reload at `/store` or `/analytics`;
  - **Log in** opens the sign-in dialog for that tenant, to sign in as any of its users, then opens its store; Cancel stays on the onboarding page.

**Header.** On the onboarding page it shows only the ShopSphere brand. Inside a tenant the brand is the tenant's name, followed by Home and (for campaign managers) Analytics, the user's name, **Logout**, which ends the session and returns to the onboarding page, and the cart. There is no Login button: signing in always starts from a tenant's row.

The chosen tenant (and its name, for the header) is kept in `localStorage` (`shopsphere:tenant`, `shopsphere:tenant-name`) and takes precedence over `VITE_TENANT_ID` until you pick another. Each store has its own cart. A tenant created with the CLI has no `onboarding` user, so use **Log in** for it.

## Sign-in and roles

A tenant row's **Log in** opens a modal with a username field and a password field, and signs in to that tenant against the auth service.
- **Session:** it's kept in `sessionStorage` (`shopsphere:session:v3`: profile, role, access token and its expiry, and the tenant it belongs to; never the password), so it lasts until the tab closes. A session of another tenant isn't restored: after switching stores, you sign in again.
- **Expiry:** the token expires after 30 minutes, and the app then signs out automatically.
- **Logout:** it ends the session on the server too.

Only `campaign-manager` users see the **Analytics** link. Anyone else who opens `/analytics` sees "Access restricted", and the dashboard code is never downloaded. This is a convenience in the UI; the API enforces the role on every request.

> The token lives in `sessionStorage`, which any script on the page can read, so the app must stay free of XSS. An `httpOnly` cookie would avoid this but needs backend support.

## Analytics events

Components call `trackEvent()` (or `track()` from `useAnalytics()` inside an `<AnalyticsWrapper>`). Every event is kept locally: run `__shopsphereAnalytics.getEvents()` in the browser console.

| Event | Emitted when |
|---|---|
| `home_view` | Once per home page visit |
| `campaign_impression` | A carousel slide is at least 50% visible: one per campaign on the slide |
| `campaign_navigation` | The user changes slide |
| `product_click` | The user clicks a product card, which opens the product's page (`/store/products/:id`) |
| `add_to_cart` | Add to cart is pressed on a catalog card (`source`: `catalog_grid`) or on the product page (`featureName`: `product_detail`). Carousel cards have no Add to cart |
| `cart_view`, `cart_quantity_update`, `remove_from_cart` | Cart page activity |
| `login_click` | The sign-in modal is opened |

When `VITE_API_BASE_URL` is set, every event is also sent to `POST /analytics/events`, which stores it with its `productId` and `campaignId` (if any) and the other properties. Campaign activity also produces the events the campaign metrics count:

| Shopper action | Also sent to the backend |
|---|---|
| A campaign's slide becomes visible | `impression` for that campaign (sent instead of `campaign_impression`) |
| A click on a card in the carousel (a campaign card), which opens the product's page | `click` (an ad click) |
| Add to cart of a product that had an ad click in the last 24 hours, anywhere in the store (this tab) | `click_to_basket`, credited to that click through `attributionId` |

Add to cart is never an ad click itself, even on a campaign card: without an earlier card click on that product it sends only `add_to_cart`.

Each click is credited to at most one basket addition. Clicks are remembered in `sessionStorage` (`shopsphere:ad-clicks:v1`). Sending never blocks or breaks shopping: failures are logged and dropped.

## Campaign carousel

The carousel mixes products from all active campaigns:
- `buildCarouselItems()` in `src/features/campaigns/carouselItems.js` takes the 1st product of each campaign, then the 2nd of each, and so on, in slides of 3.
- Each card shows a tag naming its campaign.
- A product listed in several campaigns appears once.

## Project layout

```
src/
  api/                httpClient (apiRequest, ApiError), requestContext (tenant, user, token)
  app/                App shell and routes
  analytics/          trackEvent, event schema, transports (local + backend), attribution
  components/         layout (Header, Footer) and common (Button, Toast, Spinner, AnalyticsWrapper)
  features/catalog/   CatalogProvider: products + active campaigns from the API
  features/products/  ProductCard, ProductGrid; productData.js = sample data (seed + tests)
  features/campaigns/ CampaignCarousel; campaignData.js = sample data (seed + tests)
  features/cart/      CartContext, CartPage (cart saved in localStorage: shopsphere:cart:v2)
  features/analytics/ dashboard and the /ad metrics client
  features/auth/      sign-in, session, LoginModal, RequireRole
  pages/HomePage.jsx
```

The tests don't need the backend: they render the app with the sample catalog, and `mockFetch()` (`src/test/mockFetch.js`) answers API calls.

In development, React StrictMode mounts each component twice. Data requests are shared while pending (`src/api/sharedRequest.js`) instead of being cancelled on unmount, so each one is sent once.

## Notes

- **Sample data:** `productData.js` and `campaignData.js` are no longer used by the app. They're the source for `npm run seed` in the backend, and the test fixtures.
- **Catalog size:** the store loads up to 100 products and 100 campaigns. Pagination isn't needed at this size.
- **Rates:** CTR = clicks ÷ impressions × 100, and click-to-basket rate = click-to-basket ÷ clicks × 100. Both are shown with 2 decimals, or `—` when the denominator is 0.
- **What the counts mean:** they are event totals, not unique customers.
- **Time range:** the dashboard's *Time range* dropdown offers the last 7, 30 or 90 days or the last year (each including today), or a custom range of up to 366 days. It opens on the last 30 days. Days are UTC days, the same days as the backend's daily aggregates, and the line under the toolbar shows exactly which days are counted. A preset sends only `from` (UTC midnight of its first day), so today is counted up to now; a custom range also sends `to`, the midnight after its last day. The range logic is in `timeRange.js`.
- **Freshness:** the backend loads events into ClickHouse in micro-batches, so dashboard counts update within about 30 seconds of an event.
