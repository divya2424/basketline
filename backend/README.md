# Basketline: backend

The backend of [Basketline](../README.md), an ads analytics platform for retailers: five Node.js + TypeScript services behind one gateway, a Flink SQL job, ClickHouse for the metrics, and Airflow for the archive and backfills.

**The product is the analytics side** (analytics-service, Flink, ClickHouse, Airflow). auth-, product- and campaign-service stand in for a retailer's own systems: they own the tenant's users, catalog and campaigns, and send them to Basketline the way any retailer's backend would, through the retail API with an integration token (`packages/platform/src/retailer.ts`). Apart from that, services talk to each other only through **Kafka** events.

**Contents:**
- Getting started: [Services and URLs](#services-and-urls) · [Run it](#run-it) · [Test it](#test-it)
- Using it: [API](#api) · [Analytics pipeline](#analytics-pipeline) · [Kafka topics](#kafka-topics-and-events)
- Running it: [Operations](#operations) · [Upgrading an existing setup](#upgrading-an-existing-setup) · [Known limitations](#known-limitations)
- Code: [Code layout](#code-layout)

```
                   ┌──────────── gateway :8080 ────────────┐
 frontend ──HTTP──►│ CORS · rate limits · JWT check ·       │──HTTP──► one service per request
                   │ session revocation · route permissions │
                   └────────────────────────────────────────┘
 auth-service      product-service     campaign-service        analytics-service (no Postgres)
   identity_db        product_db          campaign_db             │ publish           ▲ /ad counts (SQL)
     │  publish          │  publish          ▲ consume  │           ▼                   │
     ▼                   ▼                   │          │         retail.interactions.v1  ClickHouse
 auth.user.v1      product.v1 ─────────────── ┘          │         retail.identity-events.v1 ──► flink-streaming ──┘
 auth.session.v1 ──► gateway                             │
                         └──── POST /retail/catalog, /retail/campaigns ──► analytics-service ──► retail.catalog-events.v1,
                               (as the retailer's backend)                                       retail.campaign-events.v1 ──► ClickHouse copies
```

**Principles:**
- **A database per service.** Each service has its own Postgres database and its own login, which can't connect to any other service's database. analytics-service stores nothing and only reads ClickHouse.
- **Local copies instead of calls.** A service that needs another's data keeps a *projection* built from that service's events. For example, campaign-service keeps a `products` table and checks product IDs against it.
- **The analytics pipeline:**
  1. analytics-service validates each event and publishes it to its topic.
  2. Flink credits basket additions to ad clicks and builds sessions.
  3. ClickHouse loads the results and counts the `/ad` metrics.
  4. The Flink job appends raw events to the Iceberg archive on S3; Airflow archives sessions, compacts the archive and backfills history.
- **No build step.** Plain Express everywhere, on Node 24, which runs the `.ts` files directly.

## Services and URLs

Everything below runs with `docker compose up -d --build`, as the Compose project `basketline`: containers are named `basketline-<service>-1` (e.g. `basketline-gateway-1`), and data lives in the `basketline_*` volumes. The development credentials are for local use only.

| Service | URL (from your machine) | Inside Compose | Notes |
|---|---|---|---|
| **Gateway** (the API) | http://localhost:8080/api/v1 | `gateway:8080` | The only HTTP entry point. Health: http://localhost:8080/health/ready |
| auth-service | not published | `auth-service:4001` | Accounts, users, sign-in, tokens, vendors' API keys |
| product-service | not published | `product-service:4002` | Products |
| campaign-service | not published | `campaign-service:4003` | Campaigns |
| analytics-service | not published | `analytics-service:4004` | Event ingestion and `/ad` metrics |
| **Flink** web UI | http://localhost:8081 | `flink-streaming:8081` | Job graph, checkpoints, backpressure |
| **Airflow** UI | http://localhost:8082 | `airflow:8080` | DAGs `archive_export`, `archive_maintenance`, `history_backfill`, `tenant_purge`; no login (local only) |
| **ClickHouse** HTTP / SQL console | http://localhost:8123 · http://localhost:8123/play | `clickhouse:8123` | User `basketline`, password `basketline_dev`, database `analytics` |
| **Kafka** | `localhost:9092` | `kafka:19092` | No UI; use the CLI in the container (see [Operations](#operations)) |
| **Postgres** | `localhost:5432` | `postgres:5432` | Superuser `postgres` / `postgres`; one database and login per service (`infra/postgres/init.sql`) |
| **S3** for the archive (SeaweedFS) | http://localhost:8333 · UI http://localhost:23646 | `archive-storage:8333` | Bucket `ad-insights-archive`, keys `archive` / `archive_dev` |
| Frontend (dev server) | http://localhost:5173 | — | Started from `../frontend` with `pnpm dev` |
| **Grafana** (profile `monitoring`) | http://localhost:3000 | `grafana:3000` | Dashboard "Pipeline" (the home page); viewing needs no login, editing `admin` / `basketline_dev` |
| **Prometheus** (profile `monitoring`) | http://localhost:9090 · alerts http://localhost:9090/alerts | `prometheus:9090` | Scrapes Flink, ClickHouse, the pipeline's SQL metrics and Kafka lag |

The four services aren't published to the host. Reach their health probes from inside the container:

```bash
docker compose exec auth-service wget -qO- localhost:4001/health/ready   # 4002 product, 4003 campaign, 4004 analytics
```

## Run it

```bash
cd backend
export NODE_AUTH_TOKEN=<GitHub token with read:packages>   # see below
pnpm install
pnpm keys                     # ES256 key pair → keys/ (git-ignored)
docker compose up -d --build     # everything in the table above
```

**The token:** the Kafka event bus is its own package, [`@divya2424/basketline-kafka`](https://github.com/divya2424/basketline-kafka), on GitHub Packages, which needs a token even to install. Use a classic personal access token with only `read:packages`, in `NODE_AUTH_TOKEN`. pnpm takes registry tokens only from your user config, so add `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` to `~/.npmrc` once (the project's `.npmrc` only says which registry `@divya2424` packages come from). Docker builds get the token as the build secret `npm_token` (`docker-compose.yml`), so it never ends up in an image.

The quickest way in is the frontend's onboarding page. It creates a tenant with an `onboarding` campaign manager (password `test`), plus sample products and campaigns.

**From the command line instead** (the default storefront tenant, `VITE_TENANT_ID` in `../frontend/.env.example`):

```bash
cli() { docker compose exec auth-service node services/auth-service/src/cli.ts "$@"; }
cli create-account --name 'Default storefront' --tier free --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
cli create-user --username maya --password 'correct horse battery' --role campaign-manager \
  --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
pnpm seed                     # 10 sample products and 4 campaigns in that tenant (safe to re-run)
```

| CLI command | What it does |
|---|---|
| `create-account --name … [--tier free\|pro\|enterprise] [--tenant <uuid>]` | Creates a tenant (generates the UUID if omitted) |
| `create-user --username … --password … --role … --tenant <uuid>` | Creates a user. Registration through the API only ever creates standard users |
| `set-role --username … --role … --tenant <uuid>` | Changes a role (published as an event, so the gateway picks it up) |
| `disable --username … --tenant <uuid>` | Disables a user |
| `seed-tenant --tenant <uuid>` | Seeds a tenant onboarded before seeding existed (needs its `onboarding` user) |
| `create-api-key --tenant <uuid> --name '…'` | A vendor's secret API key for `POST /auth/shopper-token`. Printed once; only its hash is stored |
| `list-api-keys --tenant <uuid>` | The tenant's keys: prefix, name, created, revoked |
| `revoke-api-key --tenant <uuid> --prefix bl_sk_…` | Revokes a key; its shopper tokens stop being issued at once |

All data is per tenant: a campaign manager sees and changes only their tenant's products, campaigns and metrics.

**Frontend:** set `VITE_API_BASE_URL=http://localhost:8080/api/v1` in `../frontend/.env`. The gateway allows CORS from http://localhost:5173 (`CORS_ORIGINS`).

## Test it

| Command | Covers | Needs running |
|---|---|---|
| `pnpm verify` | Typecheck, architecture check, unit and integration tests | postgres, kafka, clickhouse |
| `pnpm test:e2e` | The full flow through the gateway, with real Kafka | the whole stack |
| `pnpm test:flink` | Attribution through Kafka → Flink → ClickHouse, from the shared cases | the whole stack |
| `pnpm test:airflow` | The Iceberg export job (needs [uv](https://docs.astral.sh/uv/)) | clickhouse, postgres, archive-storage |
| `pnpm test:backfill` | The history backfill in Spark local mode; runs in the Airflow container | the whole stack, with a rebuilt `airflow` image |

The analytics tests create and drop their own ClickHouse database.

## API

All paths are under http://localhost:8080/api/v1. Errors share one format, `{ "error": { "code", "message", "requestId", "details"? } }`. Validation failures are `400 VALIDATION_FAILED`, with `details.errors: string[]`.

### Tenants and auth

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/accounts` | anyone | Every tenant, newest first: `{items: [{tenantId, name, tier, createdAt}]}` |
| POST | `/accounts` | anyone | Demo onboarding: `{name, tier, dummyUsers}` → 201 `{account, users, password, apiKey, seed}`. `apiKey` is the vendor's first API key, shown only here |
| DELETE | `/accounts/:tenantId` | anyone | Deletes the tenant and all of its data: `{confirmName}` must be the tenant's name exactly, else 400 `CONFIRMATION_MISMATCH` → `{deleted: {tenantId, name, deletedAt}}`. See [Deleting a tenant](#deleting-a-tenant) |
| GET | `/auth/api-keys` | campaign manager | The tenant's API keys: `{items: [{prefix, name, createdAt, revokedAt}]}`, never the keys |
| POST | `/auth/api-keys` | campaign manager | `{name}` → 201 `{key, prefix, name, createdAt}`: a new key, shown only here |
| DELETE | `/auth/api-keys/:prefix` | campaign manager | Revokes the key (404 if no active key has that prefix) |
| GET | `/auth/allowed-origins` | campaign manager | The tenant's allowed websites: `{origins: ["https://shop.example", …]}`; empty means any website |
| PUT | `/auth/allowed-origins` | campaign manager | `{origins: [...]}` replaces the list (at most 20; each `http(s)://host[:port]`, no path or wildcard). Normalized and deduplicated; publishes `TenantOriginsChanged` |
| POST | `/auth/register` | anyone | `{username, password, visitorToken?}` → a standard user in the `tenant_id` header's tenant |
| POST | `/auth/login` | anyone | `{username, password, clientType: web\|mobile}` → `{accessToken, expiresIn: 1800, user, session}`. Rate limited |
| POST | `/auth/visitor` | anyone | `{userId?, clientType?}` → `{visitorToken, expiresIn: 1800, userId}`. Valid only for `POST /analytics/events`. Rate limited per IP |
| POST | `/auth/shopper-token` | a vendor's backend, with `Authorization: ApiKey bl_sk_…` | `{customerId, visitorId?, clientType?}` → `{shopperToken, expiresIn: 1800, userId}`: a registered, events-only token for the vendor's signed-in customer. Rate limited per API key |
| POST | `/auth/integration-token` | a retailer's backend, with `Authorization: ApiKey bl_sk_…` | → 201 `{integrationToken, expiresIn: 900}`: a 15-minute token for the retail API (`/retail/*`) only |
| POST | `/auth/logout` | signed in | Ends the session and publishes `SessionRevoked` |
| GET | `/auth/me` | signed in | The current user |
| GET | `/auth/sessions` | signed in | The user's sessions, newest first; `?limit&offset` |

- **Tenant header:** register, login and visitor tokens need the storefront's `tenant_id` header (a UUID; else `400 TENANT_REQUIRED`), for an existing account (else `404 TENANT_NOT_FOUND`). Usernames are unique per tenant.
- **Tokens:** they carry the tenant (`tid`) and client type (`client`).
- **Onboarding** creates:
  - an `onboarding` campaign manager, plus `user01`–`user10` and the seller manager `seller01` with `dummyUsers: true`, **all with the password `test`**;
  - sample sellers (with a first-party one), 10–15 sample products and 2 active campaigns, seeded by product- and campaign-service from `TenantOnboarded` within seconds, and sent to the retail API.
- **Roles:** `campaign-manager` (the retailer's admin: every seller), `seller-manager` (one seller: its token carries `sel`, and `/ad` answers only for that seller's campaigns; the CLI's `create-user --role seller-manager --seller <id>`), `standard-user` (a shopper).
- **Shopper tokens (vendors' signed-in customers):**
  - **How:** a vendor's shoppers aren't Basketline users, so the vendor's backend vouches for them with its secret API key.
  - **Same person:** each `customerId` is mapped to one Basketline `userId` on its first token: the `visitorId` passed (if it's free), else a random one. So a visitor who signs in stays one person.
  - **Where it works:** the token is accepted only by event ingestion, where it counts as `registered`.
  - **Errors:** a wrong, revoked or other tenant's key gets `401 INVALID_API_KEY`.
  - **Allowed websites:** a tenant can list the websites its events may come from (dashboard → Integrate your site → Allowed websites, or `PUT /auth/allowed-origins`). The gateway then answers `403 ORIGIN_NOT_ALLOWED` when a browser page on another website calls `/auth/visitor` or `/analytics/events` for that tenant. It goes by the `Origin` header, which a browser always sends and a page can't change. Not checked:
    - tenants with no list (any website, as before);
    - Basketline's own apps (`CORS_ORIGINS`);
    - requests without an `Origin` (vendors' servers, mobile apps), which the rate limits cover.

    The gateway learns a change from `TenantOriginsChanged` (`auth.tenant.v1`), within seconds.
  - **Keys:** every tenant gets a first key at onboarding (`apiKey`, named "Default"). Its campaign managers create and revoke keys in the dashboard (`/auth/api-keys`) or with the CLI. Keys are stored hashed, so a key is shown only when it's created.
  - **The client side:** see the SDK, [divya2424/basketline-sdk](https://github.com/divya2424/basketline-sdk).
- **Register with a visitor token:** the new user keeps the visitor's UUID, so their analytics stay one person. An invalid token, another tenant's, or a UUID that's already a user gets a random ID instead; the sign-up never fails over it. A `role` field is rejected.

### Catalog

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/products`, `/products/:id` | anyone | One tenant's catalog; `?category&includeInactive&limit&offset` |
| GET | `/sellers` | anyone | The tenant's sellers: `{items: [{id, name}]}` |
| POST / PATCH | `/products`, `/products/:id` | campaign manager | `{sellerId, name, description, price, image?, category?}`; `sellerId` (one of the tenant's sellers) on create only, it never changes; price > 0, 2 decimals |
| DELETE | `/products/:id` | campaign manager | Deactivates (never hard-deleted) |
| GET | `/campaigns`, `/campaigns/:id` | anyone | One tenant's campaigns, with `productIds`; `?status&includeArchived&limit&offset` |
| POST | `/campaigns` | campaign manager | `{sellerId, title, type, description?, status?, startTime?, endTime?, productIds?}`, in one transaction. Its products must be its seller's (else 422 `PRODUCT_OF_ANOTHER_SELLER`) |
| PATCH | `/campaigns/:id` | campaign manager | Status: draft → active\|completed, active → paused\|completed, paused → active\|completed |
| DELETE | `/campaigns/:id` | campaign manager | Archives (soft delete) |
| GET / POST | `/campaigns/:id/products` | GET anyone, POST manager | POST `{productIds: [...]}` |
| DELETE | `/campaigns/:id/products/:productId` | campaign manager | Removes one product |

- **Which tenant:** reads use the signed-in user's tenant, else the `tenant_id` header. `includeInactive` and `includeArchived` work only for campaign managers. Another tenant's product or campaign is 404.
- **A product the campaign service doesn't know yet:** right after a product is created, campaign-service may not have its event yet. Adding it to a campaign then returns `409 PRODUCT_NOT_YET_AVAILABLE` with `Retry-After: 5`; retry.

### Analytics

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/analytics/events` | access or visitor token | `{tenantId, userId, userType, events: [...]}`, 1–100 events → `accepted`/`rejected` per event |
| GET | `/ad/:campaignId/impressions` \| `clicks` \| `clickToBasket` | campaign or seller manager | `?from&to` → `{count, customers, total_*, customers_*, period}` |
| GET | `/ad/:campaignId/uniqueCustomers` | campaign or seller manager | → `has_visited`, its web, mobile, both, registered and visitor splits |
| GET | `/ad/:campaignId/sessions` | campaign or seller manager | → `total_sessions`, `total_converted_sessions`, `avg_session_duration_ms` |
| GET | `/ad/sellers/:sellerId/<metric>` | campaign manager, or that seller's manager | The same metrics over all the seller's campaigns: `{sellerId, campaigns, count, …}`. Customers are merged, so one counts once across campaigns |
| POST | `/retail/catalog` | integration token | `{events: [{eventName, updatedAt?, data}]}`, 1–500: `seller_upserted` `{sellerId, name}`, `product_upserted` `{productId, sellerId?, name, category?, price?, isActive?}`, `product_removed` `{productId}` → 202 `{accepted}` |
| POST | `/retail/campaigns` | integration token | `campaign_upserted` `{campaignId, sellerId, title, status, startTime?, endTime?, archived?, productIds}`, `campaign_removed` `{campaignId}` |
| POST | `/retail/identity` | integration token | `user_identified` `{userId, visitorId?}`, `user_deleted` `{userId}` (erasure) |

- **Identity check on events:** the batch's tenant, user and user type must match its token (`registered` for an access token, `visitor` for a visitor token). Any difference, or a `tenant_id` header for another tenant, rejects the whole batch with `403 IDENTITY_MISMATCH`.
- **Event errors:** `429 TOO_MANY_EVENTS` past 300 events per sender per minute; `503 EVENTS_NOT_DELIVERED` when Kafka is down.
- **`/ad` columns:** `count` is the event total and `customers` the people behind it. The columns split them:
  - `total_web_clicks`, `total_mobile_clicks`;
  - `customers_clicks`, and its `_web_`, `_mobile_`, `_registered_` and `_visitor_` variants;
  - the same pattern for impressions and click-to-basket.
- **`/ad` period:** the default is the last 30 days, at most 366, counted in whole UTC days: `from` rounds down to midnight and `to` up to the next one. The response's `period` shows the rounded bounds.
- **`/ad` tenant:** counts cover the token's tenant only (a `tenant_id` header is ignored). An unknown campaign has `count: 0`.
- **`/ad` for a seller manager:** another seller's campaign is 404 (its existence isn't revealed), another seller's totals 403.
- **The retail API** is how a retailer's backend tells Basketline what exists: its sellers, their products and campaigns, and server-side identity. The SDK's server entry (`@divya2424/basketline-sdk/server`) wraps it. Each update is the record's full state; `updatedAt` (default now) orders them, so the newest wins and retries or reordering are safe. IDs may be the retailer's own (a SKU, a code: letters, digits, `._:/-`, up to 128) or UUIDs; the API maps an own ID to a stable UUIDv5 of (tenant, kind, ID), the same in `/analytics/events`. A product without a seller is the tenant's first-party seller's. A campaign whose products aren't known yet, or belong to another seller, is kept and flagged in `analytics.campaigns.issues`.

## Analytics pipeline

### Events

Each event is `{eventId, eventName, timestamp, pageName?, featureName?, properties?}`. What it's about goes in `properties`: `campaignId` (required on `impression` and `click`), `productId` (what click-to-basket credits), and any other attribute. On arrival, analytics-service lifts `campaignId` and `productId` out of `properties` into their own fields, which attribution and the `/ad` metrics key on.

- **Who sent it.** A registered user sends their access token. A visitor gets a visitor token for the UUID the client keeps for them, from `POST /auth/visitor`. The client keeps the same UUID before and after registration. The stored tenant, `userId`, `userType` and `clientType` always come from the token.
- **Checks on arrival:**
  - the sender: a batch whose `User-Agent` is a bot's (crawlers, headless browsers, uptime checkers) is refused as `INVALID_TRAFFIC` and counted in `analytics.invalid_traffic_daily` (per day, tenant and reason). Generic HTTP clients aren't on the list, since mobile apps send them;
  - the format: a known `eventName`, campaign and product IDs as UUIDs or the retailer's own IDs (mapped as in the retail API), and a `properties.campaignId` on metric events;
  - the timestamp: at most 5 days old, at most 5 minutes ahead;
  - the rate: 300 events per sender per minute, per instance;
  - for metric events, an active, unarchived campaign of the sender's tenant (else `CAMPAIGN_NOT_ACTIVE`). The check reads `analytics.campaigns`, built from `retail.campaign-events.v1` and cached for 10 s.
- **What's added:** each event gets its `eventType` (`interaction` or `identity`, from its name) and the `sellerId` of its product, from the catalog copy (`analytics.products`, cached). An event without a product, or for one the catalog hasn't sent yet, has none; seller reports go through the campaign, which always has a seller.

  Interactions go to `retail.interactions.v1`, identity events to `retail.identity-events.v1`.
- **Interactions:** the metric events `impression` and `click`, and **storefront activity** (`home_view`, `campaign_navigation`, `product_impression`, `product_click`, `add_to_cart`, `cart_view`, `cart_quantity_update`, `remove_from_cart`), stored for analysis. `add_to_cart` also feeds click-to-basket.
- **Identity:** from the browser, `login_click`, `signup_click`, `login` and `logout` (stored like interactions, and part of sessions); from the retailer's server only (`/retail/identity`), `user_identified` and `user_deleted`. `user_deleted` is never stored: analytics-service records the shopper in `analytics.deleted_users` and deletes their rows (see [Deleting a tenant](#deleting-a-tenant)).

### Click-to-basket attribution

Clients send plain `add_to_cart` events. There is no `click_to_basket` event and no link to a click, and both are rejected.
- **The rule:** Flink credits an `add_to_cart` of product P to the same user's **latest** `click` on P in the **7 days** before it.
- **Across registration:** a click made as a visitor still counts after signing in, since the UUID stays the same.
- **Order:** either event may arrive first, up to 5 days late.
- **Candidates:** Flink writes every candidate click to `analytics.attributed_baskets`, and ClickHouse credits the latest one.

Details are in [flink/README.md](flink/README.md).

### Sessions

A user's events with no gap of 6 hours or more form a session, built by Flink into `analytics.sessions`. A session is written about 7 hours after its last event, so `/ad/:id/sessions` runs that far behind. See [flink/README.md § Sessions](flink/README.md).

### Where the metrics live

| Table | Holds | Read by |
|---|---|---|
| `analytics.events`, `attributed_baskets`, `sessions` | Raw rows, partitioned by day, **kept 20 days** (longer than a Kafka replay reaches: 14 days of arrivals + 5 days late): the newest 7 on local disk, older ones on S3 (`infra/clickhouse/config/storage.xml`) | The hourly check, the sessions export |
| `analytics.daily_campaign_aggregation` | Event counts per day, tenant and campaign, total and per client type (`SummingMergeTree`) | `/ad/:id/impressions`, `clicks`, `clickToBasket` |
| `analytics.daily_campaign_customers_aggregation` | `uniqCombined64` sketches of the customers per day: everyone (`has_visited*`) and per metric (`customers_*`) | `/ad/:id/uniqueCustomers`, and `customers` on the others |
| `analytics.daily_campaign_sessions_aggregation` | Sessions, converted sessions and average duration per day | `/ad/:id/sessions` |
| `analytics.sellers`, `products`, `campaigns` | The retail API's reference data, the latest state per ID (`ReplacingMergeTree(version)`): each product's and campaign's seller, a campaign's status and `issues` | Ingestion (campaign check, seller stamping), seller-manager access, `/ad/sellers/…` |
| `analytics.invalid_traffic_daily`, `deleted_users` | Refused bot traffic per day; erased shoppers | Monitoring; the Kafka queue views and the archive purge |

- **Daily tables:** one row per UTC day (when the user acted, not when the event was stored), **kept forever**, partitioned by month, sorted by `(tenant_id, campaign_id, day)`. Any period is one small range read.
- **Counting rules:**
  - a duplicate event counts once (`uniqExact(event_id)`);
  - a credited basket addition counts once per click and product;
  - customers are sketches, exact up to a few thousand and within about 1% above. Someone active on several days, on both apps, or as a visitor and then registered, counts once.
  - `has_visited_in_both` is derived as web + mobile − total.
- **Kept current:**
  - materialized views add each stored batch to its day as it lands, so today is live;
  - a copy in a later batch (a retry or a replay) counts twice until the hourly check.
- **Hourly check, 5 minutes past each hour** (`daily_campaign_aggregation_check_mv`):
  - it recounts each day (today included) that got rows in the last 3 hours from the raw events, and appends the difference, so every day is exact within the hour;
  - basket additions are recounted with their latest click, so a campaign that lost the credit is corrected down.

  Run it now with `SYSTEM REFRESH VIEW analytics.daily_campaign_aggregation_check_mv`, then `SYSTEM WAIT VIEW …`.
- **Older days** (beyond the 20 raw ones): the `history_backfill` Airflow DAG recomputes closed months from the Iceberg archive with Spark, for one tenant or all, and swaps them in atomically. See [airflow/README.md § Backfilling history](airflow/README.md#backfilling-history).
- **Archive:** Iceberg on S3, kept forever. The Flink job appends raw events and credited basket additions as they arrive; sessions are copied nightly ([airflow/README.md](airflow/README.md)).
- **As a cluster** (production), when one node can't hold the raw days:
  - **Shards by tenant:** each table becomes `<table>_local` on every shard, with a `Distributed` table under the old name over them, sharded by `cityHash64(tenant_id)`, so the services' queries don't change. Every query filters on `tenant_id`, so it reads one shard. A tenant too big for one shard gets a sub-key, such as `(tenant_id, cityHash64(user_id))`.
  - **Replicas:** two per shard, in a `Replicated` database (ClickHouse Keeper), so the schema files apply once to every node and the hourly check refreshes on one replica per shard (`02_materialized_views.sql`).
  - **Kafka:** each shard's queue tables share their consumer groups, so the serving topics' partitions are split between shards (give those topics at least as many partitions as there are shards). Their views insert into the `Distributed` tables, not the local ones, so each row lands on its tenant's shard whichever shard read it.
- **Freshness:** dashboards show data under a minute old. In the worst case:
  - the storefront batches events every 2 s;
  - Flink writes within about a second;
  - ClickHouse stores what it reads at least every 15 s;
  - `/ad` caches for 15 s (`METRICS_CACHE_MS`);
  - the dashboard refreshes every 20 s.
- **Limits:**
  - clearing storage, another browser or private mode makes a new visitor;
  - a visitor who signs in to an account created elsewhere stays a separate person;
  - in the rare case where one basket's candidate clicks (in two campaigns) are stored in different batches, its customer stays in both campaigns' click-to-basket customers. Sketches can't be corrected by subtraction, while the event count is fixed nightly.

Example: `SELECT day, sum(total_clicks) FROM analytics.daily_campaign_aggregation WHERE tenant_id = toUUID('5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01') GROUP BY day ORDER BY day`.

## Kafka topics and events

Every event has the envelope `{eventId, eventType, eventVersion, occurredAt, producer, aggregateId, aggregateVersion, payload}`. The message key is `aggregateId`, so one product's, campaign's or user's events stay in order.

| Topic | Events | Consumed by |
|---|---|---|
| `auth.user.v1` | UserCreated, UserRoleChanged, UserDisabled | gateway (disabled accounts, stale tokens) |
| `auth.session.v1` | SessionRevoked | gateway (rejects revoked sessions) |
| `auth.tenant.v1` | TenantOnboarded, with the seed plan; TenantDeleted; TenantOriginsChanged | product-service, campaign-service (seed by the planned IDs); on TenantDeleted every service deletes its own data, and the gateway rejects the tenant's tokens; the gateway keeps TenantOriginsChanged's allowed websites |
| `product.v1` | ProductCreated, ProductUpdated, ProductDeactivated (the retailer's internal events) | campaign-service (its `products` table) |
| `campaign.v1` | CampaignCreated, CampaignUpdated, CampaignProductAssociated, CampaignProductRemoved (internal) | nobody yet (analytics learns campaigns from the retail API) |
| `retail.interactions.v1` | AnalyticsEventRecorded for every interaction, all tenants (key = the client's `eventId`). Kept **14 days** | flink-streaming |
| `retail.identity-events.v1` | Identity events, from the browser and the retailer's server. Kept **14 days** | flink-streaming (stores the browser's), analytics-service (`user_deleted`) |
| `retail.catalog-events.v1`, `retail.campaign-events.v1` | The retail API's updates, keyed by entity ID. **Compacted**: the latest state per ID is kept for good | analytics-service (`analytics.sellers`, `products`, `campaigns`) |
| `retail.heartbeat.v1` | WatermarkHeartbeat: the current time, every 30 s from analytics-service, so sessions close when no events arrive. Kept **1 hour** | flink-streaming (moves the watermark only; nothing is stored) |
| `serving.events.v1`, `serving.attributed_baskets.v1`, `serving.sessions.v1` | Flink's output, one JSON row per ClickHouse row. Kept **48 hours** | ClickHouse (Kafka engine tables, `infra/clickhouse/03_kafka.sql`) |

- **Retention:** analytics-service sets it when it creates a topic. Flink keeps clicks for 13 days, so the interaction topics' 14 days let a replay rebuild all of it. Other topics keep Kafka's default of 7 days.
- **Why shared topics:** every tenant's events of one domain share its topic (keyed and filtered by tenant). A domain gets a topic of its own only when its retention, access, throughput or processing differ: reference data is compacted, identity carries erasures, interactions are the volume. So adding retailers or event names adds no topics.
- **The old `analytics.<eventName>.v1` topics** (one per event name, before the shared ones) are still read by Flink's source pattern, so a replay in the 14 days after the upgrade reaches them. Remove that branch and the topics after that (see [Upgrading](#upgrading-an-existing-setup)).
- **Consumers:**
  - the gateway records each `eventId` in `processed_events`, so a redelivery applies once;
  - campaign-service skips an event older than the version it holds;
  - a failing message is retried 5 times with backoff, then sent to `dlq.<service>`.

## Operations

### Health probes and shutdown

Every service serves three probes itself, not through the gateway:

| Probe | 200 when | Use as |
|---|---|---|
| `GET /health/live` | The process serves HTTP | Liveness |
| `GET /health/startup` | Migrations ran and Kafka consumers are subscribed | Startup |
| `GET /health/ready` | Started, not shutting down, `database` (or `clickhouse`) and `kafka` reachable | Readiness |

**On `SIGTERM`:**
1. `/health/ready` turns 503.
2. The service waits `SHUTDOWN_DRAIN_MS` (5 s).
3. It finishes in-flight requests.
4. It closes Kafka, then the database.
5. It exits 0. Past `SHUTDOWN_TIMEOUT_MS` (25 s) it exits 1.

Compose and the Helm charts use a 35 s grace period.

### Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | all but analytics-service | The service's own database |
| `CLICKHOUSE_URL` | analytics-service, airflow | e.g. `http://basketline:basketline_dev@clickhouse:8123/analytics` |
| `METRICS_CACHE_MS` | analytics-service | How long an `/ad` count is reused (default 15000; 0 turns it off) |
| `KAFKA_BROKERS` | all | e.g. `kafka:19092` |
| `KAFKA_TOPIC_PREFIX`, `KAFKA_REPLICATION` | all | Environment isolation; the replication factor of created topics (default 1) |
| `JWT_PUBLIC_KEY_FILE` / `JWT_PRIVATE_KEY_FILE` | all / auth-service | Verify / sign tokens |
| `LOGIN_RATE_LIMIT` | auth-service | Attempts per IP and username per 15 minutes (default 10) |
| `AUTH_/PRODUCT_/CAMPAIGN_/ANALYTICS_SERVICE_URL` | gateway | Where to route requests |
| `CORS_ORIGINS`, `RATE_LIMIT_PER_MINUTE`, `EVENTS_RATE_LIMIT_PER_MINUTE`, `VISITOR_RATE_LIMIT_PER_MINUTE` | gateway | Allowed origins; per-IP limits (defaults 300, 120 and 10 per minute). The SDK's endpoints (`/auth/visitor`, `/analytics/events`) accept any origin (they take bearer tokens, never cookies), unless the tenant lists allowed websites |
| `SHOPPER_TOKEN_RATE_LIMIT_PER_MINUTE` | gateway | Shopper tokens per minute per API key (default 600); this route isn't limited per IP, since a vendor's backend calls from few IPs |
| `PORT`, `LOG_LEVEL`, `SHUTDOWN_DRAIN_MS`, `SHUTDOWN_TIMEOUT_MS` | all | |
| `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_STARTUP_MODE`, `CHECKPOINT_DIR`, … | flink-streaming | See [flink/README.md](flink/README.md) |
| `PYICEBERG_CATALOG__ARCHIVE__*`, `ARCHIVE_S3_URL` | airflow | The archive's catalog and S3; see [airflow/README.md](airflow/README.md) |

### Replaying a projection

A service's local copy of another's data can be rebuilt by replaying that service's topics. It's safe: consumers skip events they've already applied.

```bash
docker compose stop campaign-service
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group campaign-service --reset-offsets --to-earliest --all-topics --execute
docker compose start campaign-service
```

Consumer groups: `campaign-service`, `gateway`, `analytics-service`. When the events have expired, product-service can republish every product's current state: `docker compose exec product-service node services/product-service/src/cli.ts republish`.

### Resetting and replaying ClickHouse

ClickHouse holds only what was derived from Kafka, so it can be rebuilt from the topics, for example after a schema change, or for a volume older than the schema files (`infra/clickhouse/`, which run only on a new volume). Three small tables can't come back from Kafka, so they are copied aside first: campaign statuses, deleted tenants (restored before the replay, so their events stay out) and backfill runs.

```bash
ch() { docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery "$@"; }
kg() { docker compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 "$@" < /dev/null; }
# backfill_runs exists once a history backfill has run; leave its lines out before that.
ch -q "CREATE DATABASE analytics_backup;
  CREATE TABLE analytics_backup.campaigns AS analytics.campaigns; INSERT INTO analytics_backup.campaigns SELECT * FROM analytics.campaigns;
  CREATE TABLE analytics_backup.deleted_tenants AS analytics.deleted_tenants; INSERT INTO analytics_backup.deleted_tenants SELECT * FROM analytics.deleted_tenants;
  CREATE TABLE analytics_backup.backfill_runs AS analytics.backfill_runs; INSERT INTO analytics_backup.backfill_runs SELECT * FROM analytics.backfill_runs" < /dev/null
docker compose stop flink-streaming analytics-service
ch -q "DROP DATABASE analytics SYNC" < /dev/null
# ClickHouse reads only what Flink writes from now on, not the old rows.
kg --group clickhouse-events --topic serving.events.v1 --reset-offsets --to-latest --execute
kg --group clickhouse-attributed-baskets --topic serving.attributed_baskets.v1 --reset-offsets --to-latest --execute
kg --group clickhouse-sessions --topic serving.sessions.v1 --reset-offsets --to-latest --execute
ch < infra/clickhouse/01_tables.sql && ch < infra/clickhouse/02_materialized_views.sql
ch -q "INSERT INTO analytics.campaigns SELECT * FROM analytics_backup.campaigns;
  INSERT INTO analytics.deleted_tenants SELECT * FROM analytics_backup.deleted_tenants;
  CREATE TABLE analytics.backfill_runs AS analytics_backup.backfill_runs; INSERT INTO analytics.backfill_runs SELECT * FROM analytics_backup.backfill_runs" < /dev/null
# analytics-service creates the serving topics 03_kafka.sql reads.
docker compose up -d --build --wait analytics-service
ch < infra/clickhouse/03_kafka.sql
# No checkpoint: Flink replays every analytics topic from the earliest offset.
docker compose run --rm --no-deps --entrypoint sh flink-streaming -c 'rm -rf /checkpoints/*'
docker compose up -d --build flink-streaming
ch -q "DROP DATABASE analytics_backup" < /dev/null   # once the counts look right
```

Once the counts stop changing, the hourly check makes every day exact (or run it at once: `SYSTEM REFRESH VIEW analytics.daily_campaign_aggregation_check_mv`). Sessions come back as the replay's watermark passes them.

**What's lost:**
- days Kafka no longer keeps (14 days of analytics events). Their daily totals come back from the archive with the `history_backfill` DAG ([airflow/README.md](airflow/README.md#backfilling-history));
- rows written straight into ClickHouse (by tests).

### Restoring ClickHouse from a backup

The `clickhouse_backup` Airflow DAG backs up, daily at 02:30 UTC, the tables nothing else can rebuild: the daily totals (kept forever), `campaigns`, `deleted_tenants`, `backfill_runs` and `invalid_traffic_daily` (`airflow/jobs/backup_clickhouse.py`). They go to S3 under `clickhouse-backups/<day>/` and expire after 35 days (`airflow/s3-lifecycle.json`). Raw tables aren't backed up: a replay of Kafka (14 days) brings them back.

After losing the ClickHouse volume, on a new one (the schema files create empty tables):

```bash
ch() { docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery "$@"; }
B="S3('http://archive-storage:8333/ad-insights-archive/clickhouse-backups/2026-10-31', 'archive', 'archive_dev')"   # the newest backup; on AWS, S3('<url>') with ClickHouse's IAM role
docker compose stop flink-streaming analytics-service
ch -q "RESTORE TABLE analytics.daily_campaign_aggregation, TABLE analytics.daily_campaign_customers_aggregation,
         TABLE analytics.daily_campaign_sessions_aggregation, TABLE analytics.campaigns, TABLE analytics.deleted_tenants,
         TABLE analytics.invalid_traffic_daily, TABLE analytics.sellers, TABLE analytics.products, TABLE analytics.deleted_users
       FROM $B SETTINGS allow_non_empty_tables = true" < /dev/null
# Reference data, erasures and tenant deletions since the backup: analytics-service applies them again.
kg() { docker compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 "$@" < /dev/null; }
kg --group analytics-service --topic retail.catalog-events.v1 --topic retail.campaign-events.v1 --topic retail.identity-events.v1 --topic auth.tenant.v1 --reset-offsets --to-datetime 2026-10-31T02:30:00.000 --execute
# Raw rows: Flink replays Kafka's 14 days; the hourly check then makes the replayed days exact.
docker compose run --rm --no-deps --entrypoint sh flink-streaming -c 'rm -rf /checkpoints/*'
docker compose up -d flink-streaming analytics-service
```

Everything after the backup comes back from Kafka. Days older than the replay keep their backed-up totals, and the history backfill can recompute them from the archive.

### Monitoring

```bash
docker compose --profile monitoring up -d   # Prometheus, Grafana and a Kafka lag exporter
```

Grafana's **Pipeline** dashboard (http://localhost:3000) shows the Flink job (uptime, restarts, failed checkpoints, records per second, late events), Kafka consumer lag, the newest stored event, the hourly check, the newest backup, invalid traffic per tenant, and events in the last hour per seller. Configuration in `infra/monitoring/`:

- **Sources:** Flink's Prometheus reporter (`flink/config.yaml`, ports 9249 and 9250); ClickHouse's own metrics (`:9363`); the pipeline's health read from its tables (`:8123/pipeline-metrics`, a query in `infra/clickhouse/config/prometheus.xml`); `kafka-exporter` for lag.
- **Alerts** (`alerts.yml`, listed at http://localhost:9090/alerts): a target down, ClickHouse consumers falling behind, the Flink job down or restarting, failing checkpoints, late events dropped, the hourly check failing or stale, no backup for 26 hours, and an invalid-traffic spike. No Alertmanager locally: route them to a pager on AWS. `BackupStale` fires until the first nightly backup has run.
- The per-seller metric has one series per seller with events in the last hour; at many thousands of sellers, chart it from ClickHouse instead.

### Looking at the data

| What | How |
|---|---|
| ClickHouse | http://localhost:8123/play, or `docker compose exec clickhouse clickhouse-client --user basketline --password basketline_dev` |
| identity_db | `docker compose exec postgres psql -U postgres -d identity_db`. Row-level security hides other tenants' users; `postgres` bypasses it, or run `SELECT set_config('app.tenant_id', '<uuid>', false)` first |
| Kafka topics | `docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list` |
| The archive | http://localhost:23646, or Athena/Trino on AWS ([airflow/README.md](airflow/README.md)) |

## Upgrading an existing setup

**ClickHouse.** The schema files in `infra/clickhouse/` (tables, materialized views, Kafka tables, run in name order) apply only to a new volume. Rebuild an older one from them: see [Resetting and replaying ClickHouse](#resetting-and-replaying-clickhouse). A new table needs nothing more: the schema files use `CREATE … IF NOT EXISTS`, so run `01_tables.sql` (or `02_materialized_views.sql`) again. A change to an existing table, which ClickHouse can't make with `IF NOT EXISTS`, goes in `infra/clickhouse/migrations/`, numbered from `001`, with its commands at its top.

**Everything else.** Apply these once, in order:

| Upgrade | Do |
|---|---|
| Renamed to Basketline | Docker volumes are now `basketline_*`. Before the first start, copy the old ones across: `for v in pgdata chdata flink-checkpoints archive-data; do docker run --rm -v ecommerce-analytics_$v:/from -v basketline_$v:/to alpine cp -a /from/. /to/; done`. Then, once ClickHouse is up, rebuild it (above; the ClickHouse user is now `basketline`). Everyone signs in again |
| IDs lowercased once, in analytics-service | Rebuild analytics-service first (`docker compose up -d --build analytics-service`). Flink no longer lowercases IDs, so reset its checkpoint (`flink/README.md`, "Resetting the checkpoint") only once no event in Kafka has an uppercase ID: wait 14 days, or check the analytics topics. A replay would drop such events |
| Per-tenant allowed websites | Rebuild auth-service and the gateway (`docker compose up -d --build auth-service gateway`); their migrations add `accounts.allowed_origins` and `tenant_origins` |
| Tenants can be deleted | Rebuild auth-service and the gateway (`docker compose up -d --build`) for their migrations |
| Analytics topics kept 14 days | `for t in $(docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list \| grep '^analytics\..*\.v1$'); do docker compose exec -T kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 --alter --entity-type topics --entity-name $t --add-config retention.ms=1209600000; done` |
| Serving topics kept 48 h | `kafka-configs.sh … --entity-name serving.events.v1 --add-config retention.ms=172800000` (and the other two) |
| Airflow and the Iceberg catalog on an old `pgdata` | `docker compose exec postgres psql -U postgres -c "CREATE ROLE airflow_svc LOGIN PASSWORD 'airflow_svc_dev'" -c "CREATE ROLE iceberg_svc LOGIN PASSWORD 'iceberg_svc_dev'" -c 'CREATE DATABASE airflow_db OWNER airflow_svc' -c 'CREATE DATABASE iceberg_catalog_db OWNER iceberg_svc' -c 'REVOKE CONNECT ON DATABASE airflow_db, iceberg_catalog_db FROM PUBLIC' -c 'GRANT CONNECT ON DATABASE airflow_db TO airflow_svc' -c 'GRANT CONNECT ON DATABASE iceberg_catalog_db TO iceberg_svc'` |
| `auth_db` → `identity_db` | `docker compose stop auth-service`, then `docker compose exec postgres psql -U postgres -c 'ALTER DATABASE auth_db RENAME TO identity_db' -c 'ALTER ROLE auth_svc RENAME TO identity_svc' -c "ALTER ROLE identity_svc PASSWORD 'identity_svc_dev'"`, then `docker compose up -d --build auth-service` |
| Unused `analytics_db` | `docker compose exec postgres psql -U postgres -c 'DROP DATABASE analytics_db'` |
| Shared retail topics and sellers | 1. ClickHouse: `migrations/004_sellers_and_event_types.sql`, then `01_tables.sql` and `03_kafka.sql` (commands at the top of 004). 2. The archive's new columns: `docker compose exec airflow sh -c 'cd /opt/airflow/jobs && /opt/jobs/bin/python -c "from pyiceberg.catalog import load_catalog; from export_archive import iceberg_table; c = load_catalog(\"archive\"); [iceberg_table(c, \"archive\", t) for t in (\"events\", \"attributed_baskets\", \"sessions\")]"'`. 3. `docker compose up -d --build` (the services' migrations give existing products the first-party seller). 4. Reset Flink's checkpoint (`flink/README.md`): the join's rows changed. 5. Send existing data through the retail API: `docker compose exec product-service node services/product-service/src/cli.ts republish`, then `docker compose exec campaign-service node services/campaign-service/src/cli.ts republish` (gives each older campaign its products' seller) |
| Old per-event topics, 14 days after the above | Drop `\|analytics\..+\.v1` from `flink/sql/connectors/analytics_events.source.sql`, rebuild flink-streaming, then delete the `analytics.*.v1` topics |
| ClickHouse waits for `archive-storage` | Nothing: a ClickHouse started before its cold volume's storage left the tiered tables unloaded; compose now orders them. If it happens, `docker compose restart clickhouse` |

## Deleting a tenant

`DELETE /accounts/:tenantId` (or **Details → Delete tenant** on the onboarding page) removes everything the tenant owns, for good:

| Where | What | When |
|---|---|---|
| auth-service (`identity_db`) | users, sign-ins, API keys, shopper mappings, the account | in the request, then it publishes `TenantDeleted` on `auth.tenant.v1` |
| gateway | records the tenant in `deleted_tenants`: its access, visitor and shopper tokens get 401 `TENANT_DELETED` | on the event |
| product-service, campaign-service | products, campaigns and their links | on the event |
| analytics-service (ClickHouse) | raw events, attributed baskets, sessions, the daily tables, the campaign projection; adds the tenant to `analytics.deleted_tenants`, which the Kafka queue views filter on, so events still in flight are dropped | on the event |
| Airflow `tenant_purge` (daily 02:00 UTC) | the tenant's rows in the Iceberg archive and the backfill tables | next run, and again each day for 15 days, since a Kafka replay can archive its events again (marked done in `deleted_tenants`) |

The Kafka topics keep the tenant's past messages until they expire (14 days at most); nothing reads them back into a deleted tenant.

**Erasing one shopper:** the retailer's server sends `user_deleted` (`POST /retail/identity`, or the server SDK's `identity.deleteUser`). analytics-service records the shopper in `analytics.deleted_users` and deletes their raw rows at once; the Kafka queue views drop any a replay brings back; `tenant_purge` deletes their archived rows, on the same 15-day terms. The daily tables hold no user IDs (counts and sketches).

## Known limitations

- **No transactional outbox, by choice.** Events are published right after the database commit. If Kafka is unreachable at that moment, the change is saved but its event is lost (logged as an error). This departs from PRD §3.3 / §5.2 and acceptance criterion 10.
- **Revocation is eventually consistent.** After logout, the gateway rejects the token once `SessionRevoked` arrives, under 5 s in tests. Only the gateway checks revocation.
- **Retries are in-process.** A message being retried blocks its partition for up to about 3 s before going to the dead-letter topic.
- **Public catalog reads, by choice.** `GET /products` and `/campaigns` need no token, so visitors can browse. This departs from PRD §6.2 and §6.3. All writes still require a campaign manager.
- **Anonymous events can be faked, at a cost.** Anyone can get a visitor token. This is limited, not prevented:
  - 10 visitor tokens per IP per minute;
  - 300 events per token per minute;
  - only active campaigns count;
  - a tenant that lists allowed websites refuses browser pages on other sites. Scripts outside a browser can send any `Origin`, so they're held only by the limits above.
- **Tenants are isolated in the data, not the infrastructure.** Every row and query is scoped by tenant, but tenants share the services, databases and topics.
- **Reference data comes from the retailer.** Analytics knows a product's seller and a campaign only once the retailer's backend has sent them (the retail API). The topics are compacted, so a rebuilt ClickHouse gets them all back by replaying them.
- **Events don't get a seller later.** An event for a product the catalog hadn't received yet keeps `seller_id` NULL; nothing fills it in when the product arrives. Seller reports go through campaigns, which always have a seller, so they aren't affected.
- **Onboarding is open to anyone.** `GET` and `POST /accounts` need no sign-in, and onboarded users have the password `test`. That suits demos only: put these routes behind an admin role before real tenants use the platform.
- **Deleting a tenant is open to anyone,** like onboarding: typing the tenant's name is a guard against mistakes, not a permission. Put `DELETE /accounts/:tenantId` behind an admin role too.
- **Not implemented:** `CampaignMetricUpdated` events, OpenAPI files, refresh tokens, a time-series endpoint.

## Code layout

```
packages/contracts/   event types, topic names, roles, the retail API's payloads and ID mapping (shared definitions only)
packages/platform/    shared infrastructure: Express middleware, Drizzle helpers and shared tables,
                      JWT, health, shutdown; re-exports the Kafka event bus
                      (@divya2424/basketline-kafka, its own repo)
services/<service>/
  drizzle/            SQL migrations generated by drizzle-kit (applied on startup)
  src/
    index.ts          database, Kafka, consumers, server, shutdown
    app.ts            the Express app (service → controller → routes)
    routes/           URL + middleware → controller
    controllers/      (req, res) handlers
    services/         business rules and transactions; publish events after commit
    repositories/     database queries (Drizzle)
    validators/       plain functions returning error messages
    events/           Kafka consumers that update local projections
    cli.ts            operator commands (auth: users, keys; product, campaign: republish)
    db/schema.ts      the service's tables (source of truth)
flink/                the Flink SQL job (flink/README.md)
airflow/              the archive export and history backfill (airflow/README.md)
loadtest/             k6 load test for the analytics path (loadtest/README.md)
deploy/helm/          Kubernetes: a Helm chart per service, helmfile (deploy/helm/README.md)
infra/                Postgres and ClickHouse schemas and migrations; monitoring (Prometheus, Grafana)
scripts/              generate-keys.ts, check-architecture.ts
test/                 architecture, end-to-end and Flink tests
```

**Databases:**
- **Drizzle:** every service except analytics-service uses Drizzle ORM on its own database. analytics-service uses `@clickhouse/client`.
- **Shared tables:** `audit_log` and the gateway's `processed_events` are defined once in `packages/platform/src/tables.ts`.
- **Tenant isolation in identity_db:** `users` and `user_login` are tenant-scoped by Postgres row-level security. auth-service runs every query in `withTenant()`.

To change a service's tables:

```bash
# edit services/<service>/src/db/schema.ts, then:
pnpm --filter @basketline/<service> db:generate   # writes services/<service>/drizzle/<n>.sql
pnpm db:generate                                      # or every service
# commit the file; it is applied when the service starts
```
