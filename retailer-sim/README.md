# Simulated retailer

A stand-in for a retailer that integrates [Basketline](../README.md), so the integration can be shown end to end. It isn't part of the product.

| Folder | What it is |
|---|---|
| [`services/product-service`](services/product-service) | The retailer's catalog: sellers and products (port 4002, `product_db`) |
| [`services/campaign-service`](services/campaign-service) | The retailer's ad campaigns (port 4003, `campaign_db`) |
| [`storefront/`](storefront/) | The web shop, tracking shoppers with the Basketline SDK ([README](storefront/README.md)) |
| [`deploy/helm/`](deploy/helm/) | A Helm chart per service and a helmfile, next to the platform's ([Basketline's Helm README](../basketline/deploy/helm/README.md)) |

As a retailer's backend, the services send their sellers, products and campaigns to Basketline's retail API (`/retail/*`). They still lean on the platform in ways a real retailer wouldn't, until they integrate only through its public API:
- they verify Basketline's JWTs and seed a new tenant from its `auth.tenant.v1` topic;
- they get integration tokens with a shared internal secret, not an API key;
- the storefront signs shoppers in at Basketline's `/auth/login`;
- they use the platform's Postgres and Kafka, and its `@basketline/platform` and `@basketline/contracts` packages (one pnpm workspace, at the repo root).

## Run it

Start the platform first (`../basketline`, which also creates the JWT keys this folder mounts), then:

```bash
cd retailer-sim
docker compose up -d --build     # NODE_AUTH_TOKEN set, as for the platform's images
docker compose ps
cd storefront && pnpm dev        # http://localhost:5174
```

The services join the platform's network (`basketline_default`), where the gateway reaches them as `product-service:4002` and `campaign-service:4003`. Their CLIs, from here:

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
