# Simulated retailer

A stand-in for a retailer that integrates [Basketline](../README.md), so the integration can be shown end to end. It isn't part of the product.

| Folder | What it is |
|---|---|
| [`services/retailer-auth-service`](services/retailer-auth-service) | The store's logins (customers and staff), connecting stores to Basketline, and Basketline shopper tokens for signed-in customers (port 4006, `retailer_auth_db`) |
| [`services/product-service`](services/product-service) | The retailer's catalog: sellers and products (port 4002, `product_db`) |
| [`services/campaign-service`](services/campaign-service) | The retailer's ad campaigns (port 4003, `campaign_db`) |
| [`packages/shared`](packages/shared) | What the services share: the retailer's events and topics, its tokens, sealing API keys, the seed plan, and the Basketline client (onboarding, shopper tokens, sending records with the SDK's server entry) |
| [`storefront/`](storefront/) | The web shop and its Stores page, tracking shoppers with the Basketline SDK ([README](storefront/README.md)) |
| [`deploy/helm/`](deploy/helm/) | A Helm chart per service and a helmfile, next to the platform's ([Basketline's Helm README](../basketline/deploy/helm/README.md)) |

It integrates only through Basketline's public API, as a real retailer would:

1. **Connecting a store** (the storefront's Stores page → `POST /api/v1/stores` at retailer-auth-service): it onboards the store at Basketline (`POST /accounts`, which creates its `onboarding` campaign manager), seals the API key it gets back (AES-256-GCM, `RETAILER_SECRETS_KEY`) and keeps it. It creates the store's logins, `staff` and the customers `user01`–`user10` (password `test`), and publishes `StoreConnected` on its own topic `retailer.store.v1`, with the sealed key and a seed plan.
2. **Catalog and campaigns:** product- and campaign-service save the store's key from `StoreConnected`, seed its sellers, products and campaigns, and send every change to Basketline's retail API (`/retail/*`) with the SDK's server entry (`createBasketlineServer`), which trades the API key for integration tokens.
3. **Customers:** the storefront signs in at retailer-auth-service. For a customer, it gets a Basketline shopper token with the store's API key (`POST /auth/shopper-token`, with the customer's ID and the browser's visitor ID), which the storefront hands to the SDK. Staff (`staff`, who manage products and campaigns) and visitors send events as the visitor.
4. **Analytics:** the store's Basketline users sign in to Basketline's dashboard (http://localhost:5173).

Its tokens are its own (issuer `retailer-auth`, its keys in `keys/`), as are its Postgres and its Kafka topics. It still shares the platform's Kafka broker and the generic `@basketline/platform` package (one pnpm workspace, at the repo root); `../basketline/scripts/check-architecture.ts` checks it uses none of Basketline's topics or databases.

## Run it

Start the platform first (`../basketline`), then:

```bash
cd retailer-sim
pnpm keys                        # once: keys/ (its token key pair and secrets key), never committed
docker compose up -d --build     # NODE_AUTH_TOKEN set, as for the platform's images
docker compose ps
cd storefront && pnpm dev        # http://localhost:5174; connect a store at /stores
```

The services run on their own Postgres (`retailer-postgres`, host port 5433) and join the platform's network (`basketline_default`) for its Kafka and its gateway (`BASKETLINE_API_URL=http://gateway:8080/api/v1`). They're published on 127.0.0.1 only: 4006 (sign-in, stores), 4002 (products, sellers) and 4003 (campaigns), which the storefront's dev server proxies. Deleting a tenant at Basketline doesn't reach the retailer: connect the store again.

To send every product and campaign to Basketline again (e.g. after Basketline's ClickHouse was rebuilt):

```bash
docker compose exec product-service node retailer-sim/services/product-service/src/cli.ts republish
docker compose exec campaign-service node retailer-sim/services/campaign-service/src/cli.ts republish
```

## Tests

| Command | Covers | Needs |
|---|---|---|
| `pnpm verify` | Lint, typecheck, the services' unit and integration tests | postgres, kafka (`../basketline`) |
| `cd storefront && pnpm test` | The storefront | Nothing |

Basketline's architecture check (`cd ../basketline && pnpm check:architecture`) covers these services too, and its e2e test (`pnpm test:e2e`) runs them in the full flow.
