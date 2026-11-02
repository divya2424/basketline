# Basketline: platform design at scale

How the platform is bounded, deployed and kept fair between tenants, and how live and historical metrics are served. Diagrams:

- [`platform-architecture.svg`](platform-architecture.svg): the logical view. The platform starts where events are ingested; the retailer's own systems are outside.
- [`deployment-aws.svg`](deployment-aws.svg): the production deployment on AWS.
- [`current-architecture.svg`](current-architecture.svg): what runs locally in Docker Compose.

## 1. Where the platform starts

Basketline is the analytics path. The repository also simulates a retailer, so the integration can be shown end to end:

| | Services | Role |
|---|---|---|
| **Retailer systems** (simulated) | product-service, campaign-service; the storefront | The retailer's catalog, sellers and campaigns. They send them to Basketline's retail API (`/retail/catalog`, `/retail/campaigns`) with an integration token, as any retailer's backend would (the SDK's `/server` entry). |
| **Platform edge** | gateway, auth-service (identity and access) | Routing, per-IP limits, CORS; API keys, visitor, shopper and integration tokens, dashboard users. |
| **Ingestion** | analytics-service | Validates every event, refuses bots, stamps the product's seller, holds each tenant to its budget, publishes to Kafka. |
| **Stream** | Kafka | `retail.interactions.v1` and `retail.identity-events.v1` (14 days), `retail.catalog-events.v1` and `retail.campaign-events.v1` (compacted), the watermark heartbeat. Shared by every tenant. |
| **Processing** | Flink | Click→basket attribution (7-day join), sessions, the Iceberg archive writer. |
| **Serving** | ClickHouse, the `/ad` API, the dashboard | Raw days, daily tables, reference copies; the insights API reads the daily tables. |
| **Archive and batch** | Iceberg on S3, Airflow | The system of record; backups, backfills, purges, the sessions export. |
| **Observability** | Prometheus, Grafana, alerts | Every layer above. |

## 2. One heavy tenant next to quiet ones

The rule: **a tenant's load spreads across the platform, and each tenant is capped at its share**, so a busy tenant uses more machines rather than one machine's all.

| Layer | What spreads the load | What caps a tenant |
|---|---|---|
| **Edge** (gateway) | Stateless pods behind the load balancer; the autoscaler adds pods on CPU | Per-IP limits (requests, event posts, visitor tokens) |
| **Ingestion** (analytics-service) | Stateless pods, scaled on CPU; each process handles about 250 requests/s (2,250 events/s), measured | **Per sender:** 300 events/minute. **Per tenant, by tier:** `TENANT_EVENTS_PER_MINUTE_FREE/PRO/ENTERPRISE` (default 60k / 600k / 6M per pod, i.e. 1k / 10k / 100k events/s). Over budget, the whole batch gets `429 TENANT_RATE_LIMITED` with `Retry-After`; the SDK retries once (waiting up to 10 s), then reports it to `onError`. The tier comes from `TenantOnboarded` (`analytics.tenants`). |
| **Kafka** | Messages are keyed by event ID, so one tenant's events spread over **every** partition: no hot partition, whatever the tenant mix. Partitions are sized for the platform's peak (48 for 100k events/s) | The ingestion budget above is the gate; Kafka absorbs bursts (14 days kept) |
| **Flink** | Keyed by (tenant, user, product) for attribution and (tenant, user) for sessions: a big tenant's state spreads over every task. The Flink Kubernetes Operator's autoscaler adds parallelism when consumer lag grows | Nothing per tenant is needed: its input is already capped |
| **ClickHouse writes** | Batched inserts from the serving topics; at scale, shards by `cityHash64(tenant_id)` | — |
| **ClickHouse reads** (`/ad`) | Daily tables: one row per tenant, campaign and day, so any range is a small read; a 15 s cache absorbs repeated dashboards | **Every query is bounded:** 10 s, 4 threads, 2 GB (`READ_LIMITS`, `metrics.repository.ts`), so one tenant's long range can't hold every core |

**When a limit is reached:**
- The edge or ingestion answers 429; the SDK retries once after `Retry-After` and reports a second refusal to the page's `onError`. Other tenants are unaffected.
- A burst the consumers can't keep up with waits in Kafka; Flink and ClickHouse catch up, and the dashboard is a little behind for that time (the Grafana lag panel and `ClickHouseConsumerLagGrowing` alert show it).
- An overloaded Kafka consumer group starts its consumer again instead of crashing the service (`@divya2424/basketline-kafka` 0.1.2).

**For the very largest tenants:** give them their own ClickHouse shard (the sharding key can place a tenant explicitly), a dedicated ingestion node pool, or their own topic. That is configuration, not new code, and only worth it when a tenant is a large share of the total.

**Known limit:** the budgets are counted per pod, so across N ingestion pods a tenant gets N times its budget. A shared counter (e.g. Redis) makes it exact; the per-pod budget is set to the target divided by the expected pod count until then.

## 3. Live and historical metrics: keep ClickHouse for both

**Recommendation: one serving store, ClickHouse, for live and historical numbers.** The dashboard never queries S3.

| | How it works | How fresh |
|---|---|---|
| **Live** (today) | Flink → serving topics → ClickHouse; materialized views add each stored batch to its day's row in the daily tables | Seconds (7.5 s median at 1,000 events/s, measured) |
| **Corrected** (the "every 30 min–1 hour" aggregation) | The hourly check recounts every day that got rows in the last 3 hours from the raw events and fixes duplicates and late arrivals | Exact within the hour |
| **Historical** (older days) | The daily tables are kept forever and are tiny, so a year's range is still a millisecond read. Raw rows are kept 20 days | Final |
| **Recomputed** (months past the raw 20 days) | The Spark backfill recomputes closed months from the Iceberg archive and swaps them into the daily tables | On demand |

**Why not aggregate only every 30–60 minutes?** The live materialized views cost almost nothing extra (they update one small row per batch). Dropping them would make the dashboard up to an hour old for no real saving. Keep the hourly job as the *correction*, not the only source.

**Why not read history from S3 (Athena or Trino)?** A dashboard read would cost per data scanned and take seconds instead of milliseconds. S3 is for analysts' ad-hoc questions and for rebuilding ClickHouse, not for serving.

## 4. Every tenant's raw data in S3: yes, as the system of record

- **One shared set of Iceberg tables** (events, attributed baskets, sessions) for all tenants, partitioned by day and tenant bucket (16), written by Flink as events arrive. A tenant's query or deletion reads only its bucket's files.
- **Lifecycle tiers:** S3 Standard, then Infrequent Access after 30 days, then Glacier Instant Retrieval after 180 days. Iceberg reads them all transparently; storage costs about 2× less in Infrequent Access and about 6× less in Glacier Instant Retrieval than in Standard (us-east-1 list prices).
- **Per tenant:** deletion through the purge job (tenants and erased shoppers), exports by partition, and retention per contract.
- **Isolation by exception:** a separate bucket, namespace and KMS key only for tenants with data-residency or contractual isolation needs, in their region.
- **What it enables:** rebuilding ClickHouse, history backfills, analysts' queries (Athena, Trino, Snowflake external tables), and ML features, without touching the serving path.
