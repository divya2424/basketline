# Basketline: backend

The backend of [Basketline](../README.md): five Node.js + TypeScript services behind one gateway, a Flink SQL job, ClickHouse for the metrics, and Airflow for the archive and backfills. Services talk to each other only through **Kafka** events; there are no service-to-service HTTP calls.

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
     │  publish          │  publish          ▲ consume  │ publish   ▼                   │
     ▼                   ▼                   │          ▼         analytics.<event>.v1  ClickHouse
 auth.user.v1      product.v1 ─────────────── ┘    campaign.v1    topics ──► flink-streaming ──┘
 auth.session.v1 ──────────────────────────► gateway (gateway_db: revoked sessions)
```

**Principles:**
- **A database per service.** Each service has its own Postgres database and its own login, which can't connect to any other service's database. analytics-service stores nothing and only reads ClickHouse.
- **Local copies instead of calls.** A service that needs another's data keeps a *projection* built from that service's events. For example, campaign-service keeps a `products` table and checks product IDs against it.
- **The analytics pipeline:**
  1. analytics-service validates each event and publishes it to its topic.
  2. Flink credits basket additions to ad clicks and builds sessions.
  3. ClickHouse loads the results and counts the `/ad` metrics.
  4. Airflow archives raw events to Iceberg on S3 and backfills history.
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
| **Airflow** UI | http://localhost:8082 | `airflow:8080` | DAGs `archive_export`, `history_backfill`; no login (local only) |
| **ClickHouse** HTTP / SQL console | http://localhost:8123 · http://localhost:8123/play | `clickhouse:8123` | User `basketline`, password `basketline_dev`, database `analytics` |
| **Kafka** | `localhost:9092` | `kafka:19092` | No UI; use the CLI in the container (see [Operations](#operations)) |
| **Postgres** | `localhost:5432` | `postgres:5432` | Superuser `postgres` / `postgres`; one database and login per service (`infra/postgres/init.sql`) |
| **S3** for the archive (SeaweedFS) | http://localhost:8333 · UI http://localhost:23646 | `archive-storage:8333` | Bucket `ad-insights-archive`, keys `archive` / `archive_dev` |
| Frontend (dev server) | http://localhost:5173 | — | Started from `../frontend` with `npm run dev` |

The four services aren't published to the host. Reach their health probes from inside the container:

```bash
docker compose exec auth-service wget -qO- localhost:4001/health/ready   # 4002 product, 4003 campaign, 4004 analytics
```

## Run it

```bash
cd backend
export NODE_AUTH_TOKEN=<GitHub token with read:packages>   # see below
npm install
npm run keys                     # ES256 key pair → keys/ (git-ignored)
docker compose up -d --build     # everything in the table above
```

**The token:** the Kafka event bus is its own package, [`@divya2424/basketline-kafka`](https://github.com/divya2424/basketline-kafka), on GitHub Packages, which needs a token even to install. Use a classic personal access token with only `read:packages`. `.npmrc` reads it from `NODE_AUTH_TOKEN`. Docker builds get it as the build secret `npm_token` (`docker-compose.yml`), so it never ends up in an image.

The quickest way in is the frontend's onboarding page. It creates a tenant with an `onboarding` campaign manager (password `test`), plus sample products and campaigns.

**From the command line instead** (the default storefront tenant, `VITE_TENANT_ID` in `../frontend/.env.example`):

```bash
cli() { docker compose exec auth-service node services/auth-service/src/cli.ts "$@"; }
cli create-account --name 'Default storefront' --tier free --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
cli create-user --username maya --password 'correct horse battery' --role campaign-manager \
  --tenant 5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01
npm run seed                     # 10 sample products and 4 campaigns in that tenant (safe to re-run)
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
| `npm run verify` | Typecheck, architecture check, unit and integration tests | postgres, kafka, clickhouse |
| `npm run test:e2e` | The full flow through the gateway, with real Kafka | the whole stack |
| `npm run test:flink` | Attribution through Kafka → Flink → ClickHouse, from the shared cases | the whole stack |
| `npm run test:airflow` | The Iceberg export job (needs [uv](https://docs.astral.sh/uv/)) | clickhouse, postgres, archive-storage |
| `npm run test:backfill` | The history backfill in Spark local mode; runs in the Airflow container | the whole stack, with a rebuilt `airflow` image |

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
| POST | `/auth/logout` | signed in | Ends the session and publishes `SessionRevoked` |
| GET | `/auth/me` | signed in | The current user |
| GET | `/auth/sessions` | signed in | The user's sessions, newest first; `?limit&offset` |

- **Tenant header:** register, login and visitor tokens need the storefront's `tenant_id` header (a UUID; else `400 TENANT_REQUIRED`), for an existing account (else `404 TENANT_NOT_FOUND`). Usernames are unique per tenant.
- **Tokens:** they carry the tenant (`tid`) and client type (`client`).
- **Onboarding** creates:
  - an `onboarding` campaign manager, plus `user01`–`user10` with `dummyUsers: true`, **all with the password `test`**;
  - 10–15 sample products and 2 active campaigns, seeded by product- and campaign-service from `TenantOnboarded` within seconds.
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
| POST / PATCH | `/products`, `/products/:id` | campaign manager | `{name, description, price, image?, category?}`; price > 0, 2 decimals |
| DELETE | `/products/:id` | campaign manager | Deactivates (never hard-deleted) |
| GET | `/campaigns`, `/campaigns/:id` | anyone | One tenant's campaigns, with `productIds`; `?status&includeArchived&limit&offset` |
| POST | `/campaigns` | campaign manager | `{title, type, description?, status?, startTime?, endTime?, productIds?}`, in one transaction |
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
| GET | `/ad/:campaignId/impressions` \| `clicks` \| `clickToBasket` | campaign manager | `?from&to` → `{count, customers, total_*, customers_*, period}` |
| GET | `/ad/:campaignId/uniqueCustomers` | campaign manager | → `has_visited`, its web, mobile, both, registered and visitor splits |
| GET | `/ad/:campaignId/sessions` | campaign manager | → `total_sessions`, `total_converted_sessions`, `avg_session_duration_ms` |

- **Identity check on events:** the batch's tenant, user and user type must match its token (`registered` for an access token, `visitor` for a visitor token). Any difference, or a `tenant_id` header for another tenant, rejects the whole batch with `403 IDENTITY_MISMATCH`.
- **Event errors:** `429 TOO_MANY_EVENTS` past 300 events per sender per minute; `503 EVENTS_NOT_DELIVERED` when Kafka is down.
- **`/ad` columns:** `count` is the event total and `customers` the people behind it. The columns split them:
  - `total_web_clicks`, `total_mobile_clicks`;
  - `customers_clicks`, and its `_web_`, `_mobile_`, `_registered_` and `_visitor_` variants;
  - the same pattern for impressions and click-to-basket.
- **`/ad` period:** the default is the last 30 days, at most 366, counted in whole UTC days: `from` rounds down to midnight and `to` up to the next one. The response's `period` shows the rounded bounds.
- **`/ad` tenant:** counts cover the token's tenant only (a `tenant_id` header is ignored). An unknown campaign has `count: 0`.

## Analytics pipeline

### Events

Each event is `{eventId, eventName, timestamp, pageName?, featureName?, properties?}`. What it's about goes in `properties`: `campaignId` (required on `impression` and `click`), `productId` (what click-to-basket credits), and any other attribute. On arrival, analytics-service lifts `campaignId` and `productId` out of `properties` into their own fields, which attribution and the `/ad` metrics key on.

- **Who sent it.** A registered user sends their access token. A visitor gets a visitor token for the UUID the client keeps for them, from `POST /auth/visitor`. The client keeps the same UUID before and after registration. The stored tenant, `userId`, `userType` and `clientType` always come from the token.
- **Checks on arrival:**
  - the format: UUIDs, a known `eventName`, and a `properties.campaignId` on metric events;
  - the timestamp: at most 5 days old, at most 5 minutes ahead;
  - the rate: 300 events per sender per minute, per instance;
  - for metric events, an active, unarchived campaign of the sender's tenant (else `CAMPAIGN_NOT_ACTIVE`). The check reads `analytics.campaigns`, built from `campaign.v1` and cached for 10 s.

  Valid events go to `analytics.<eventName>.v1`.
- **Metric events:** `impression` and `click`. **Storefront activity** (`home_view`, `campaign_navigation`, `product_impression`, `product_click`, `add_to_cart`, `cart_view`, `cart_quantity_update`, `remove_from_cart`, `login_click`) is stored for analysis. Its `add_to_cart` events also feed click-to-basket.

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
| `analytics.events`, `attributed_baskets`, `sessions` | Raw rows, partitioned by day, **kept 14 days** | The nightly check, the archive export |
| `analytics.daily_campaign_aggregation` | Event counts per day, tenant and campaign, total and per client type (`SummingMergeTree`) | `/ad/:id/impressions`, `clicks`, `clickToBasket` |
| `analytics.daily_campaign_customers_aggregation` | `uniqCombined64` sketches of the customers per day: everyone (`has_visited*`) and per metric (`customers_*`) | `/ad/:id/uniqueCustomers`, and `customers` on the others |
| `analytics.daily_campaign_sessions_aggregation` | Sessions, converted sessions and average duration per day | `/ad/:id/sessions` |

- **Daily tables:** one row per UTC day (when the user acted, not when the event was stored), **kept forever**, partitioned by month, sorted by `(tenant_id, campaign_id, day)`. Any period is one small range read.
- **Counting rules:**
  - a duplicate event counts once (`uniqExact(event_id)`);
  - a credited basket addition counts once per click and product;
  - customers are sketches, exact up to a few thousand and within about 1% above. Someone active on several days, on both apps, or as a visitor and then registered, counts once.
  - `has_visited_in_both` is derived as web + mobile − total.
- **Kept current:**
  - materialized views add each stored batch to its day as it lands, so today is live;
  - a copy in a later batch (a retry or a replay) counts twice until the nightly check.
- **Nightly check, 00:30 UTC** (`daily_campaign_aggregation_check_mv`):
  - it recounts each closed day that got rows in the last 26 hours from the raw events, and appends the difference;
  - basket additions are recounted with their latest click, so a campaign that lost the credit is corrected down.

  Run it now with `SYSTEM REFRESH VIEW analytics.daily_campaign_aggregation_check_mv`, then `SYSTEM WAIT VIEW …`.
- **Older days** (beyond the 14 raw ones): the `history_backfill` Airflow DAG recomputes closed months from the Iceberg archive with Spark, for one tenant or all, and swaps them in atomically. See [airflow/README.md § Backfilling history](airflow/README.md#backfilling-history).
- **Archive:** each raw day is copied to Iceberg on S3 six days after it ends and kept forever ([airflow/README.md](airflow/README.md)).
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
| `product.v1` | ProductCreated, ProductUpdated, ProductDeactivated | campaign-service (its `products` table) |
| `campaign.v1` | CampaignCreated, CampaignUpdated, CampaignProductAssociated, CampaignProductRemoved | analytics-service (`analytics.campaigns`) |
| `analytics.<eventName>.v1` | AnalyticsEventRecorded (key = the client's `eventId`). Kept **14 days** | flink-streaming |
| `serving.events.v1`, `serving.attributed_baskets.v1`, `serving.sessions.v1` | Flink's output, one JSON row per ClickHouse row. Kept **48 hours** | ClickHouse (Kafka engine tables, `infra/clickhouse/kafka.sql`) |

- **Retention:** analytics-service sets it when it creates a topic. Flink keeps clicks for 12 days, so the analytics topics' 14 days let a replay rebuild all of it. Other topics keep Kafka's default of 7 days.
- **`analytics.click_to_basket.v1`** holds only events from before attribution moved to Flink.
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

ClickHouse holds only what was derived from Kafka, so it can be rebuilt from the topics, for example after a schema change. Only what Kafka still keeps comes back (14 days of analytics events).

```bash
ch() { docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery "$@"; }
kg() { docker compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 "$@" < /dev/null; }
docker compose stop flink-streaming analytics-service
ch -q "DROP DATABASE analytics SYNC" < /dev/null
# ClickHouse reads only what Flink writes from now on, not the old rows.
kg --group clickhouse-events --topic serving.events.v1 --reset-offsets --to-latest --execute
kg --group clickhouse-attributed-baskets --topic serving.attributed_baskets.v1 --reset-offsets --to-latest --execute
kg --group clickhouse-sessions --topic serving.sessions.v1 --reset-offsets --to-latest --execute
# Rebuilds analytics.campaigns from campaign.v1.
kg --group analytics-service --topic campaign.v1 --reset-offsets --to-earliest --execute
ch < infra/clickhouse/init.sql
# analytics-service creates the serving topics kafka.sql reads.
docker compose up -d --build --wait analytics-service
ch < infra/clickhouse/kafka.sql
# No checkpoint: Flink replays every analytics topic from the earliest offset.
docker compose run --rm --no-deps --entrypoint sh flink-streaming -c 'rm -rf /checkpoints/*'
docker compose up -d --build flink-streaming
```

Once the counts stop changing, run the nightly check so closed days are exact. Sessions come back as the replay's watermark passes them.

**What's lost:**
- days Kafka no longer keeps;
- rows written straight into ClickHouse (by tests);
- campaigns whose last `campaign.v1` event has expired. Update each once to republish it.

### Looking at the data

| What | How |
|---|---|
| ClickHouse | http://localhost:8123/play, or `docker compose exec clickhouse clickhouse-client --user basketline --password basketline_dev` |
| identity_db | `docker compose exec postgres psql -U postgres -d identity_db`. Row-level security hides other tenants' users; `postgres` bypasses it, or run `SELECT set_config('app.tenant_id', '<uuid>', false)` first |
| Kafka topics | `docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list` |
| The archive | http://localhost:23646, or Athena/Trino on AWS ([airflow/README.md](airflow/README.md)) |

## Upgrading an existing setup

`init.sql` runs only on a new volume. For an older one, apply these once, in order. Each migration has its commands at its top.

| Upgrade | Do |
|---|---|
| Tenant IDs became UUIDs | `infra/clickhouse/migrations/004_uuid_tenants.sql` (drops and recreates the analytics tables). Then update each campaign once to republish it |
| Raw events expire | `infra/clickhouse/migrations/005_events_ttl.sql` |
| Spark replaced by Flink | `infra/clickhouse/migrations/006_flink.sql` (then load `kafka.sql`) |
| Hourly aggregates → daily totals | `infra/clickhouse/migrations/007_daily_campaign_aggregation.sql` |
| Raw tables by day, kept 14 days | `infra/clickhouse/migrations/008_raw_daily_partitions.sql` |
| Less frequent Kafka engine flushes | `infra/clickhouse/migrations/009_kafka_flush_interval.sql` |
| Daily tables partitioned by month (for backfills) | `infra/clickhouse/migrations/010_monthly_daily_partitions.sql` |
| Renamed to Basketline | Docker volumes are now `basketline_*`. Before the first start, copy the old ones across: `for v in pgdata chdata flink-checkpoints archive-data; do docker run --rm -v ecommerce-analytics_$v:/from -v basketline_$v:/to alpine cp -a /from/. /to/; done`. Then, once ClickHouse is up, run `infra/clickhouse/migrations/011_basketline_user.sql` and `init.sql` (the ClickHouse user is now `basketline`). Everyone signs in again |
| Per-tenant allowed websites | Rebuild auth-service and the gateway (`docker compose up -d --build auth-service gateway`); their migrations add `accounts.allowed_origins` and `tenant_origins` |
| Tenants can be deleted | `infra/clickhouse/migrations/012_deleted_tenants.sql`, then `init.sql` and `kafka.sql`. Rebuild auth-service and the gateway (`docker compose up -d --build`) for their migrations |
| Analytics topics kept 14 days | `for t in $(docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list \| grep '^analytics\..*\.v1$'); do docker compose exec -T kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 --alter --entity-type topics --entity-name $t --add-config retention.ms=1209600000; done` |
| Serving topics kept 48 h | `kafka-configs.sh … --entity-name serving.events.v1 --add-config retention.ms=172800000` (and the other two) |
| Airflow and the Iceberg catalog on an old `pgdata` | `docker compose exec postgres psql -U postgres -c "CREATE ROLE airflow_svc LOGIN PASSWORD 'airflow_svc_dev'" -c "CREATE ROLE iceberg_svc LOGIN PASSWORD 'iceberg_svc_dev'" -c 'CREATE DATABASE airflow_db OWNER airflow_svc' -c 'CREATE DATABASE iceberg_catalog_db OWNER iceberg_svc' -c 'REVOKE CONNECT ON DATABASE airflow_db, iceberg_catalog_db FROM PUBLIC' -c 'GRANT CONNECT ON DATABASE airflow_db TO airflow_svc' -c 'GRANT CONNECT ON DATABASE iceberg_catalog_db TO iceberg_svc'` |
| `auth_db` → `identity_db` | `docker compose stop auth-service`, then `docker compose exec postgres psql -U postgres -c 'ALTER DATABASE auth_db RENAME TO identity_db' -c 'ALTER ROLE auth_svc RENAME TO identity_svc' -c "ALTER ROLE identity_svc PASSWORD 'identity_svc_dev'"`, then `docker compose up -d --build auth-service` |
| Unused `analytics_db` | `docker compose exec postgres psql -U postgres -c 'DROP DATABASE analytics_db'` |

## Deleting a tenant

`DELETE /accounts/:tenantId` (or **Details → Delete tenant** on the onboarding page) removes everything the tenant owns, for good:

| Where | What | When |
|---|---|---|
| auth-service (`identity_db`) | users, sign-ins, API keys, shopper mappings, the account | in the request, then it publishes `TenantDeleted` on `auth.tenant.v1` |
| gateway | records the tenant in `deleted_tenants`: its access, visitor and shopper tokens get 401 `TENANT_DELETED` | on the event |
| product-service, campaign-service | products, campaigns and their links | on the event |
| analytics-service (ClickHouse) | raw events, attributed baskets, sessions, the daily tables, the campaign projection; adds the tenant to `analytics.deleted_tenants`, which the Kafka queue views filter on, so events still in flight are dropped | on the event |
| Airflow `tenant_purge` (daily 02:00 UTC) | the tenant's rows in the Iceberg archive and the backfill tables | next run, then marked done in `deleted_tenants` |

The Kafka topics keep the tenant's past messages until they expire (14 days at most); nothing reads them back into a deleted tenant.

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
- **The campaign projection starts from Kafka.** On a new or rebuilt ClickHouse volume, a campaign last changed more than 7 days ago is unknown until it changes again.
- **Onboarding is open to anyone.** `GET` and `POST /accounts` need no sign-in, and onboarded users have the password `test`. That suits demos only: put these routes behind an admin role before real tenants use the platform.
- **Deleting a tenant is open to anyone,** like onboarding: typing the tenant's name is a guard against mistakes, not a permission. Put `DELETE /accounts/:tenantId` behind an admin role too.
- **Not implemented:** `CampaignMetricUpdated` events, OpenAPI files, refresh tokens, a time-series endpoint.

## Code layout

```
packages/contracts/   event types, topic names, roles (shared definitions only)
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
    db/schema.ts      the service's tables (source of truth)
flink/                the Flink SQL job (flink/README.md)
airflow/              the archive export and history backfill (airflow/README.md)
loadtest/             k6 load test for the analytics path (loadtest/README.md)
deploy/helm/          Kubernetes: a Helm chart per service, helmfile (deploy/helm/README.md)
infra/                Postgres and ClickHouse schemas and migrations
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
npm run db:generate -w @basketline/<service>   # writes services/<service>/drizzle/<n>.sql
npm run db:generate                                      # or every service
# commit the file; it is applied when the service starts
```
