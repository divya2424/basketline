# Basketline: dashboard

Basketline's web app, a React + Vite app on the platform's gateway (`..`):

- **Onboarding page:** create tenants, open their dashboards, and open their stores in the simulated retailer's storefront (`../../retailer-sim/storefront`).
- **Sign-in:** against the auth service, with roles.
- **Campaign dashboard:** for campaign managers (every seller's campaigns) and seller managers (their own seller's), with the ad funnel, the audience and sessions.
- **Integration:** each tenant's SDK setup and API keys.

![The campaign dashboard: the ad funnel (impressions → clicks → click-to-basket, with the conversion rate between each step) and the audience (unique customers and sessions)](docs/dashboard.png)

## Quick start

Requirements: Node.js 20.19+ (developed on Node 24) and pnpm (`corepack enable pnpm`), with the platform running locally (`../README.md`). Dependencies are installed once for the whole repo, from its root (`pnpm install`).

```bash
cd basketline/dashboard
cp .env.example .env         # points at the gateway on http://localhost:8080/api/v1
pnpm dev                     # http://localhost:5173
```

On http://localhost:5173, onboard a tenant, then click **Analytics** on its row. You're signed in as its `onboarding` campaign manager (password `test`), with demo products and campaigns already seeded. **Open store** opens the tenant's store in the storefront (http://localhost:5174, `pnpm dev` in `retailer-sim/storefront`).

| Command | |
|---|---|
| `pnpm dev` | Development server on http://localhost:5173 (the gateway allows CORS from here) |
| `pnpm test` | Vitest + React Testing Library. No backend needed |
| `pnpm build` | Production build into `dist/` |

<details>
<summary>Using the default tenant from the CLI instead</summary>

```bash
cd basketline
docker compose exec auth-service node basketline/services/auth-service/src/cli.ts \
  create-account --name 'Default storefront' --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
docker compose exec auth-service node basketline/services/auth-service/src/cli.ts \
  create-user --username maya --password 'correct horse battery' --role campaign-manager \
  --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
pnpm seed                 # 10 sample products and 4 campaigns in that tenant
```

A tenant created this way has no `onboarding` user, so use **Log in** on its row and sign in as `maya`.
</details>

## Configuration

Set these in `.env`, starting from `.env.example`.

| Variable | Values | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | URL | The API gateway, e.g. `http://localhost:8080/api/v1`. Every API call goes here. |
| `VITE_ANALYTICS_MODE` | `live` \| `mock` | `live` reads dashboard metrics from the API. `mock` shows demo numbers for any campaign, labelled **Mock data**. |
| `VITE_TENANT_ID` | UUID | The default tenant, sent as the `tenant_id` header. Defaults to `5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01`. A tenant picked on the onboarding page takes precedence. |
| `VITE_STOREFRONT_URL` | URL | The storefront that **Open store** opens. Defaults to `http://localhost:5174`. |

## Using the app

### Onboarding and tenants

The app opens on the onboarding page (`/`), open to everyone.

- **Onboard a tenant:** give it a name and a tier (Free, Pro or Enterprise), and optionally tick "Create 10 demo users". The backend generates the tenant ID and creates:
  - an `onboarding` campaign manager;
  - `user01`–`user10` (standard users), if ticked. Every one of them has the password `test`.
  - 10–15 sample products and 2 active campaigns. They appear in its store within a few seconds;
  - its first **API key**, shown once with a Copy button, next to the tenant ID and an SDK setup snippet filled in for it.
- **Tenants list:** every tenant, newest first. Each row has:
  - **Open store:** opens the storefront on that tenant (`/store?tenant=<id>&name=<name>`), as a visitor;
  - **Analytics:** signs in as the tenant's `onboarding` user and opens `/analytics`;
  - **Log in:** sign in as any of its users, then open its dashboard;
  - **Details:** the tenant's SDK setup and its **API keys** (list, create, revoke), loaded by signing in as its `onboarding` manager for that panel only, so the app stays on its current tenant. A tenant created with the CLI has no `onboarding` user; manage its keys with the CLI. Details also has **Delete tenant**: type the tenant's name to confirm, and it and all of its data are deleted for good (see `../README.md`, "Deleting a tenant"). Deleting the tenant you're in signs you out.

`/analytics` requires signing in to that tenant. Signed out, it redirects to `/`. The chosen tenant is remembered in `localStorage` (`basketline:tenant`).

**Header:** inside a tenant it shows the tenant's name, Analytics for campaign and seller managers, the user and **Logout** (back to the onboarding page).

### Sign-in and roles

| | |
|---|---|
| **Session** | Kept in `sessionStorage` (`basketline:session:v3`: profile, role, token and expiry, tenant; never the password), so it lasts until the tab closes. Switching tenants means signing in again. |
| **Expiry** | The token lasts 30 minutes, then the app signs out. |
| **Logout** | Ends the session on the server too. |
| **Roles** | Only `campaign-manager` and `seller-manager` users see **Analytics**; a seller manager sees only their seller's campaigns (onboarding with dummy users creates `seller01`, password `test`) and not the API keys. Anyone else opening `/analytics` sees "Access restricted", and the dashboard code is never downloaded. The API enforces the role on every request regardless. |

> **Security note:** any script on the page can read `sessionStorage`, so the app must stay free of XSS. An `httpOnly` cookie would avoid this, but needs backend support.

## Campaign dashboard

`/analytics` (`src/features/analytics`) shows one campaign, or **Compare all campaigns** as a table.

| Section | Cards |
|---|---|
| **Ad funnel** | **Ad impressions → Ad clicks → Click-to-basket.** Each card shows the event count, the customers behind it, a web/mobile split and a registered/visitors split. The conversion rate between two steps sits on the arrow between them: CTR, then click-to-basket rate. |
| **Audience** | **Unique customers:** the people who saw or clicked the ad, split into web only / both / mobile only, and registered / visitors. **Sessions:** visits that saw the ad, how many converted, and the average visit. |

![Compare all campaigns: each campaign's counts with their customers, sessions and conversion rates in one table](docs/dashboard-compare.png)

The screenshots use mock data (`VITE_ANALYTICS_MODE=mock`).

**What the numbers mean**

- **Counts and customers:**
  - impressions, clicks and click-to-basket are **event counts**;
  - their **customers** are the people behind them, each counted once over the range;
  - customer and session counts are estimates, within about 1% beyond a few thousand.
- **Click-to-basket:** an add to cart of a product within 7 days of clicking that product in the ad. The latest click gets the credit. The backend works this out, not the browser.
- **Rates:**
  - **CTR** = clicks ÷ impressions × 100;
  - **click-to-basket rate** = click-to-basket ÷ clicks × 100;
  - both are shown with 2 decimals, or `—` when the divisor is 0.
- **Overlaps:** someone on both web and mobile counts once in the total. A visitor who later registered counts as both registered and visitor, and once in the total.
- **Sessions:** a visit ends after 6 hours without activity. Session numbers arrive about 7 hours after a visit ends.

**Time range.**
- **Options:** the last 7, 30 (the default) or 90 days, the last year, or a custom range of up to 366 days.
- **UTC days:** days are UTC, like the backend's daily totals, and the line under the toolbar shows exactly which days are counted.
- **What's sent:** a preset sends only `from`, so today counts up to now; a custom range also sends `to`.
- **Code:** see `timeRange.js`.

**Freshness:** counts are fetched again every 20 seconds while the page is visible, without a loader. With the backend's batching and 15-second cache, they are at most about a minute old.

**Integrate your site:** a closed section at the bottom of the dashboard, loaded only when opened. It has two parts:
- the SDK setup snippet, with the store's tenant ID;
- the store's API keys: create one (shown once, with a Copy button), see when each was created, and revoke one.

The code is in `src/features/integration`.

**Loading and errors:** each card loads on its own, with placeholders shaped like the card, and a status chip in the section header shows progress. A card that fails shows **Retry**, without hiding the others.

## How it talks to the backend

Every request goes through `apiRequest()` (`src/api/httpClient.js`), one [axios](https://axios-http.com) instance using the fetch adapter. It:
- adds the `tenant_id` header, plus `user_id` and `Authorization: Bearer <token>` when signed in;
- parses JSON;
- turns `{ error: { code, message } }` responses into an `ApiError`;
- signs the user out when a signed-in request gets a 401 (an expired or revoked session).

| Feature | API calls |
|---|---|
| Onboarding | `GET /accounts`, `POST /accounts`, `DELETE /accounts/{tenantId}` |
| Sign-in | `POST /auth/login` (`clientType: "web"`), `POST /auth/logout` |
| Campaign list | `GET /campaigns?status=active&limit=100` (with `GET /products?limit=100`), once per page load |
| Dashboard | `GET /ad/{campaignId}/impressions \| clicks \| clickToBasket \| uniqueCustomers \| sessions?from&to` |
| Integration | `GET\|POST\|DELETE /auth/api-keys`, `GET\|PUT /auth/allowed-origins` |

## Project layout

```
src/
  api/                    httpClient (apiRequest, ApiError), requestContext (tenant, user, token)
  app/                    app shell and routes
  components/             layout (Header, Footer) and common (Button, Toast, Spinner)
  features/onboarding/    the onboarding page, tenant list and details
  features/analytics/     the dashboard (MetricCard, CampaignMetricsPanel, CampaignComparison) and the /ad client
  features/integration/   SDK snippet, API keys, allowed websites
  features/catalog/       CatalogProvider: the tenant's active campaigns from the API
  features/auth/          sign-in, session, LoginModal, RequireRole, RequireTenant
```

**Testing:** the tests render the app with a sample catalog (`src/test/campaignData.js`, `productData.js`: copies of the storefront's sample data), and `mockFetch()` (`src/test/mockFetch.js`) answers API calls, so they need no backend.

**StrictMode:** in development, React mounts each component twice. Pending data requests are shared (`src/api/sharedRequest.js`) rather than cancelled on unmount, so each is sent once.
