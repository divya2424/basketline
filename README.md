# E-commerce Analytics

A multi-tenant e-commerce storefront with real-time campaign analytics. Shoppers browse a tenant's products and campaigns and fill a cart. Their activity streams through Kafka and Flink into ClickHouse, and campaign managers see on a dashboard:
- impressions, clicks and click-to-basket;
- the customers behind each, and unique customers;
- sessions.

Every tenant's data is kept apart: users, products, campaigns, events and metrics.

```
frontend (React, :5173)
   │ HTTP
   ▼
gateway (:8080) ──► auth · product · campaign · analytics services (Node.js + TypeScript)
                        │ Kafka events between services, one Postgres database each
                        ▼
              analytics.<event>.v1 ──► Flink SQL ──► serving topics ──► ClickHouse ──► /ad metrics
                                     (click→basket attribution,                │
                                      sessions)                                ▼
                                                              Airflow ──► Iceberg on S3 (archive, backfills)
```

## Quick start

Requires Node 24, Docker and npm.

```bash
# Backend: everything in "Local URLs" below
cd backend
npm install
npm run keys                 # JWT signing keys → backend/keys/ (git-ignored)
docker compose up -d --build

# Frontend
cd ../frontend
npm install
cp .env.example .env         # points at the gateway, http://localhost:8080/api/v1
npm run dev
```

1. Open http://localhost:5173 and onboard a tenant. It gets an `onboarding` campaign manager (password `test`), sample products and campaigns.
2. Click **Analytics** on its row to see the dashboard, or **Open store** to shop.

To create tenants and users from the command line, see [backend/README.md § Run it](backend/README.md#run-it).

## Local URLs

| What | URL | Sign-in |
|---|---|---|
| **Storefront and dashboard** | http://localhost:5173 | Onboard a tenant, or sign in from its row |
| **API gateway** | http://localhost:8080/api/v1 | Tokens from `/auth/login` or `/auth/visitor` |
| Gateway health | http://localhost:8080/health/ready | — |
| **Flink** web UI | http://localhost:8081 | — |
| **Airflow** UI | http://localhost:8082 | None (local only) |
| **ClickHouse** SQL console | http://localhost:8123/play | `ecommerce_analytics` / `ecommerce_analytics_dev` |
| **S3 archive** (SeaweedFS) UI · S3 API | http://localhost:23646 · http://localhost:8333 | `archive` / `archive_dev` |
| **Kafka** | `localhost:9092` | — |
| **Postgres** | `localhost:5432` | `postgres` / `postgres` |

The auth, product, campaign and analytics services (ports 4001–4004) are reached only through the gateway. See [backend/README.md § Services and URLs](backend/README.md#services-and-urls) for each service and its health probe. These are development credentials, for local use only.

## Repository layout

| Folder | What it is | Docs |
|---|---|---|
| [`frontend/`](frontend/) | The storefront, tenant onboarding and the campaign dashboard (React 19, Vite) | [frontend/README.md](frontend/README.md) |
| [`backend/`](backend/) | The gateway and four services, Kafka contracts, Postgres and ClickHouse schemas | [backend/README.md](backend/README.md) |
| [`backend/flink/`](backend/flink/) | The Flink SQL job: validation, click→basket attribution, sessions | [flink/README.md](backend/flink/README.md) |
| [`backend/airflow/`](backend/airflow/) | The nightly Iceberg archive export and the Spark history backfill | [airflow/README.md](backend/airflow/README.md) |
| [`backend/loadtest/`](backend/loadtest/) | The k6 load test for the analytics path | [loadtest/README.md](backend/loadtest/README.md) |
| [`backend/deploy/helm/`](backend/deploy/helm/) | Kubernetes: a Helm chart per service, helmfile | [helm/README.md](backend/deploy/helm/README.md) |

## Tests

| Command | Covers | Needs |
|---|---|---|
| `cd frontend && npm test` | The frontend | Nothing |
| `cd backend && npm run verify` | Typecheck, architecture check, unit and integration tests | postgres, kafka, clickhouse |
| `cd backend && npm run test:e2e` | The full flow through the gateway, with real Kafka | The whole stack |
| `cd backend && npm run test:flink` | Click→basket attribution through Kafka → Flink → ClickHouse | The whole stack |
| `cd backend && npm run test:airflow` | The Iceberg export job | The stack, and [uv](https://docs.astral.sh/uv/) |
| `cd backend && npm run test:backfill` | The history backfill (Spark local mode) | The stack, with a rebuilt `airflow` image |

## Upgrading from ShopSphere

The app used to be called ShopSphere. Every technical name now uses `ecommerce-analytics`:

| What | Old | New |
|---|---|---|
| npm packages | `@shopsphere/*` | `@ecommerce-analytics/*` |
| Compose project, Kubernetes namespace, images, Helm library chart, JWT secret | `shopsphere` | `ecommerce-analytics` |
| ClickHouse user | `shopsphere` | `ecommerce_analytics` |
| JWT issuer and audiences | `shopsphere-*` | `ecommerce-analytics-*` |
| Browser storage keys | `shopsphere:*` | `ecommerce-analytics:*` |

<details>
<summary>Moving an existing Docker or Kubernetes setup</summary>

**Docker.** The renamed Compose project gives its volumes new names (`ecommerce-analytics_*`). Copy the old data across:

```bash
cd backend
docker compose -p shopsphere down          # stops the old stack; its volumes are kept
docker compose up --no-start               # creates the new stack's volumes
for v in pgdata chdata; do
  docker run --rm -v shopsphere_$v:/from -v ecommerce-analytics_$v:/to alpine cp -a /from/. /to/
done
docker compose up -d --build
# Once everything works: docker volume rm shopsphere_pgdata shopsphere_chdata shopsphere_spark-checkpoints
```

A copied ClickHouse volume also needs the migrations in [backend/README.md § Upgrading an existing setup](backend/README.md#upgrading-an-existing-setup).

**Kubernetes.**
1. Create the `ecommerce-analytics` namespace and its `ecommerce-analytics-jwt` secret ([helm/README.md](backend/deploy/helm/README.md)).
2. Push the images as `<registry>/ecommerce-analytics/<service>`, then deploy.
3. Once the new releases are healthy, delete the `shopsphere` namespace.

**After upgrading,** everyone signs in again, because tokens from the old issuer are rejected. Browsers open on the onboarding page with an empty cart.
</details>
