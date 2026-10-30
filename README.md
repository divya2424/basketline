# E-commerce Analytics

A multi-tenant e-commerce storefront with campaign analytics. Shoppers browse a tenant's products and campaigns and fill a cart. Their activity is sent as analytics events, and campaign managers see impressions, clicks and click-to-basket counts for their campaigns on a dashboard.

Every tenant's data is kept apart: users, products, campaigns, events and metrics.

```
frontend (React + Vite, :5173)
   │ HTTP
   ▼
gateway (:8080) ──► auth · product · campaign · analytics services (Node.js + TypeScript)
                        │ Kafka events between services, one Postgres database each
                        ▼
                    analytics.<event>.v1 topics ──► Flink SQL (click→basket attribution) ──► serving topics ──► ClickHouse ──► /ad metrics
```

## Repository layout

| Folder | What it is | Details |
|---|---|---|
| [`frontend/`](frontend/) | The storefront, tenant onboarding and the campaign analytics dashboard (React 19, Vite, Vitest) | [frontend/README.md](frontend/README.md) |
| [`backend/`](backend/) | The gateway and four microservices, Kafka contracts, Postgres and ClickHouse schemas | [backend/README.md](backend/README.md) |
| [`backend/flink/`](backend/flink/) | The Flink SQL job that credits basket additions to ad clicks and loads analytics events into ClickHouse | [flink/README.md](backend/flink/README.md) |
| [`backend/loadtest/`](backend/loadtest/) | The k6 load test for the analytics path (p99 latency and freshness) | [loadtest/README.md](backend/loadtest/README.md) |
| [`backend/deploy/helm/`](backend/deploy/helm/) | Kubernetes deployment: a Helm chart per service, helmfile | [helm/README.md](backend/deploy/helm/README.md) |

## Quick start

Requires Node 24, Docker, and npm.

```bash
# Backend: Postgres, Kafka, ClickHouse, the services, the Flink job and the gateway on :8080
cd backend
npm install
npm run keys                 # the JWT signing keys, in backend/keys/ (git-ignored)
docker compose up -d --build

# Frontend
cd ../frontend
npm install
cp .env.example .env         # points at the gateway on http://localhost:8080/api/v1
npm run dev                  # http://localhost:5173
```

Open http://localhost:5173 and onboard a tenant. It gets an `onboarding` campaign manager (password `test`), sample products and campaigns. **Open store** and **Analytics** sign you in to it.

To create accounts and users from the command line, or to load the sample catalog into the default tenant, see [backend/README.md § Run it](backend/README.md#run-it).

## Tests

```bash
cd backend && npm run verify                 # typecheck, architecture check, tests (needs postgres, kafka, clickhouse running)
cd backend && npm run test:e2e               # full flow through the gateway with real Kafka
cd backend && npm run test:flink              # Flink job's attribution rules (needs the compose stack up)
cd backend && npm run test:airflow            # Iceberg export job (needs the compose stack up, and uv)
cd frontend && npm test                      # no backend needed
```

## Upgrading from ShopSphere

The app used to be called ShopSphere. Every technical name now uses `ecommerce-analytics`, as listed below.

| What | Old | New |
|---|---|---|
| npm packages | `@shopsphere/*` | `@ecommerce-analytics/*` |
| Compose project, Kubernetes namespace, images, Helm library chart, JWT secret | `shopsphere` | `ecommerce-analytics` |
| ClickHouse user | `shopsphere` | `ecommerce_analytics` |
| JWT issuer and audiences | `shopsphere-*` | `ecommerce-analytics-*` |
| Browser storage keys | `shopsphere:*` | `ecommerce-analytics:*` |

**Docker.** Renaming the Compose project gives its volumes new names, `ecommerce-analytics_*` instead of `shopsphere_*`. The steps below copy the old data across:

```bash
cd backend
docker compose -p shopsphere down          # stops the old stack; its volumes are kept
docker compose up --no-start               # creates the new stack's volumes
for v in pgdata chdata; do
  docker run --rm -v shopsphere_$v:/from -v ecommerce-analytics_$v:/to alpine cp -a /from/. /to/
done
docker compose up -d --build
# Once everything works: docker volume rm shopsphere_pgdata shopsphere_chdata shopsphere_spark-checkpoints
# The Flink job starts with a new checkpoint volume. A copied ClickHouse volume also needs
# backend/infra/clickhouse/migrations/006_flink.sql (the commands are at its top).
```

**Kubernetes.**
1. Create the `ecommerce-analytics` namespace and its `ecommerce-analytics-jwt` secret, as described in [backend/deploy/helm/README.md](backend/deploy/helm/README.md).
2. Push the images under `<registry>/ecommerce-analytics/<service>`, then deploy.
3. Once the new releases are healthy, delete the old `shopsphere` namespace.

**After upgrading:**
- Everyone signs in again, because tokens from the old issuer are rejected.
- Browsers open on the onboarding page with an empty cart. The old `shopsphere:*` storage entries are ignored.
