# Basketline

**Real-time ad insights for retail media: from ad click to basket.**

Basketline is a multi-tenant platform for online retailers and the marketers who advertise on their sites:
- **Capture:** it collects shopper and ad events as people browse.
- **Attribute:** it credits each add to cart to the ad click that led to it.
- **Integrate:** retailers add the browser SDK, [`@divya2424/basketline-sdk`](https://github.com/divya2424/basketline-sdk) (its own repo, on GitHub Packages), to their site. Their backend vouches for signed-in shoppers with an API key.
- **Report:** campaign managers see, for each campaign:
  - impressions, clicks and click-to-basket, with the customers behind each;
  - unique customers and sessions;
  - over any date range, live.

Every retailer (tenant) is kept apart: users, products, campaigns, events and metrics.

![The Basketline campaign dashboard](frontend/docs/dashboard.png)

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

Requires Node 24, Docker and pnpm (`corepack enable pnpm` gives you the version each project pins), and a GitHub token with `read:packages`: the Kafka event bus ([`basketline-kafka`](https://github.com/divya2424/basketline-kafka)) and the SDK come from GitHub Packages.

```bash
# Once: pnpm reads registry tokens only from your own config, not a project's.
echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> ~/.npmrc

export NODE_AUTH_TOKEN=<GitHub token with read:packages>

# Backend: everything in "Local URLs" below
cd backend
pnpm install
pnpm keys                 # JWT signing keys → backend/keys/ (git-ignored)
docker compose up -d --build

# Frontend
cd ../frontend
pnpm install
cp .env.example .env         # points at the gateway, http://localhost:8080/api/v1
pnpm dev
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
| **ClickHouse** SQL console | http://localhost:8123/play | `basketline` / `basketline_dev` |
| **S3 archive** (SeaweedFS) UI · S3 API | http://localhost:23646 · http://localhost:8333 | `archive` / `archive_dev` |
| **Kafka** | `localhost:9092` | — |
| **Postgres** | `localhost:5432` | `postgres` / `postgres` |

The auth, product, campaign and analytics services (ports 4001–4004) are reached only through the gateway. See [backend/README.md § Services and URLs](backend/README.md#services-and-urls) for each service and its health probe. These are development credentials, for local use only.

**Docker.** Everything runs as the Compose project `basketline`:

| | Named |
|---|---|
| Containers | `basketline-<service>-1`, e.g. `basketline-gateway-1` |
| Images | `basketline-<service>` |
| Volumes | `basketline_pgdata`, `basketline_chdata`, `basketline_flink-checkpoints`, `basketline_archive-data` |

```bash
cd backend
docker compose ps                      # every container and its health
docker compose logs -f gateway         # one service's logs
docker compose down                    # stop (volumes kept); add -v to delete the data too
```

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
| `cd frontend && pnpm test` | The frontend | Nothing |
| `cd backend && pnpm verify` | Typecheck, architecture check, unit and integration tests | postgres, kafka, clickhouse |
| `cd backend && pnpm test:e2e` | The full flow through the gateway, with real Kafka | The whole stack |
| `cd backend && pnpm test:flink` | Click→basket attribution through Kafka → Flink → ClickHouse | The whole stack |
| `cd backend && pnpm test:airflow` | The Iceberg export job | The stack, and [uv](https://docs.astral.sh/uv/) |
| `cd backend && pnpm test:backfill` | The history backfill (Spark local mode) | The stack, with a rebuilt `airflow` image |