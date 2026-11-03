# insights-service: the `/ad` API

The read path of Basketline: campaign insights, read from ClickHouse's daily tables. For example, `GET /ad/{campaignId}/clicks` returns the number of customers who clicked the ad.

The service only reads ClickHouse, as a user that sees one tenant per query. It has no write access and no Kafka connection, so neither ingestion load nor a failure in the pipeline can reach it. The design behind it: [docs/platform-design.md § 6](../../../docs/platform-design.md#6-insights-api).

## Endpoints

Mounted at `/api/v1/ad`:

| Endpoint | Returns | Who can call |
|---|---|---|
| `GET /:campaignId/:metric?from&to&storeId`<br>(metric: `clicks`, `impressions`, `clickToBasket`, `uniqueCustomers`, `sessions`) | `customers` (distinct people), `count` (events), split per client (web/mobile) and user type, and the `period` | A user (access token), or the tenant's backend (integration token) |
| `GET /:campaignId/products?from&to&storeId` | Per product: `impressions`, `clicks`, `ctr`, `addToCarts`, `clickToBasket`, with name and category | The same |
| `GET /campaigns` | The tenant's campaigns with activity, per store | A user (access token) |

- **Period:** the last 30 days by default, at most 366. It is snapped to whole UTC days, the grain of the daily tables, and a period ending now includes today.
- **`storeId`** limits the read to one store (in a marketplace, one seller). Without it, the read covers all the tenant's stores.
- **Errors:** an unknown campaign has 0 for every count. An invalid ID, date or metric is a `400` with a code (`UNKNOWN_METRIC`, `INVALID_PERIOD`, `VALIDATION_FAILED`). No token is `401` (at the gateway, which verifies it).

Example: the integration token comes from the retailer's API key.

```bash
TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/integration-token \
  -H "tenant_id: $TENANT" -H "authorization: ApiKey $API_KEY" | jq -r .integrationToken)
curl -s "localhost:8080/api/v1/ad/$CAMPAIGN/clicks?from=2026-11-01T00:00:00Z" -H "authorization: Bearer $TOKEN"
```

The response:

```json
{ "campaignId": "…", "metric": "clicks", "count": 6, "customers": 4,
  "total_web_clicks": 5, "total_mobile_clicks": 1, "customers_registered_clicks": 1, "…": "…",
  "period": { "from": "2026-11-01T00:00:00.000Z", "to": "2026-11-04T00:00:00.000Z" } }
```

## Code layout

A request goes through one layer per concern, and each layer only calls the one below it:

```
src/index.ts                  config from env, ClickHouse as the reader user, graceful shutdown
src/app.ts                    builds the Express app from its dependencies (tests pass their own)
  routes/ad.routes.ts         URLs, the caller from the gateway, UUID and query validation
  validators/metric.validator.ts   from / to / storeId checks → 400 with every error
  controllers/metrics.controller.ts  HTTP in and out: the tenant from the token, the response shape
  services/metrics.service.ts      the rules: the period, the rates, the 15 s cache of identical counts
  repositories/metrics.repository.ts  the SQL, with the tenant and the per-query limits as settings
  repositories/campaign.repository.ts  the campaign list
```

- **Dependencies are passed in, not imported.** `buildInsightsApp({ clickhouse, logger })` gets everything it needs, so the tests run the real app against a test database.
- **Shared code** comes from `@basketline/platform`: the base Express app, health checks, auth middleware, validation, errors and logging. That code is the same in every Basketline service.

## How a count is read

1. **The tenant comes from the token**, as the gateway verified it (`x-basketline-caller`), never from the URL or a client's header. A `tenant_id` header can't change it.
2. **The query reads the daily tables** (`daily_campaign_aggregation`, `daily_campaign_customers_aggregation`, `daily_campaign_sessions_aggregation`, `daily_campaign_product_aggregation`).
   - One row per tenant, store, campaign and day, kept forever. A year is 365 small rows, so "today" and "last year" are the same query.
   - The `WHERE` clause follows the sort key: tenant, store, campaign, day.
3. **Event counts are sums.** Customer counts merge `uniqCombined64` sketches across days, stores and clients, so a person counts once. They are exact for small numbers and within about 1% above a few thousand.
4. **ClickHouse enforces tenant isolation as well.**
   - The query runs as `basketline_reader`, with the tenant in the query settings (`SQL_tenant_id`).
   - A row policy (`infra/clickhouse/04_access.sql`) returns only that tenant's rows, even to a query that forgets its tenant filter.
5. **Every query is bounded** (10 s, 4 threads, 2 GB), so one tenant's long range can't take every core.
6. **Identical counts are shared.** They are cached for 15 s (`METRICS_CACHE_MS`), and requests in flight share one query, so many viewers of one campaign cost one query.

## Tests

[`test/insights.test.ts`](test/insights.test.ts) runs the app over HTTP (supertest) against its own ClickHouse database, built from the real schema and dropped afterwards. Rows are seeded as ingestion and Flink would write them. It covers:
- **Counting:** redelivered events count once; date ranges; click-to-basket credits the latest click; web/mobile/total; a visitor who signs in counts once; sessions; per-store reads; per-product results.
- **Isolation and access:** another tenant's rows are never returned, even through the row policy alone; nothing is read without the gateway's caller (who may call which route is the gateway's check).
- **Limits and cache:** the query limits and the cache.

```bash
cd basketline && pnpm vitest run services/insights-service   # needs: docker compose up -d clickhouse
```
