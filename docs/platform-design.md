# Basketline: design of a real-time retail-media analytics platform

Basketline takes shoppers' interactions and ad engagements from retailers' sites and apps, processes them as they arrive, and serves campaign insights through an API to marketers and retailers. Every retailer is a tenant on one shared platform. This document is the design: what each part does, which technology and why, how it scales, stays accurate, isolates tenants and is operated. Where something is a proposal rather than built, it says so.

Diagrams:

- [`platform-architecture.svg`](platform-architecture.svg): the logical view, from the retailer's site to the insights API.
- [`deployment-aws.svg`](deployment-aws.svg): the production deployment on AWS.
- [`current-architecture.svg`](current-architecture.svg): what runs locally in Docker Compose (the code in this repository).

## 1. Scope and the path of an event

| Layer | Built with | Role |
|---|---|---|
| **Retailer** (simulated in `retailer-sim/`) | Its own services, storefront and the Basketline SDK | Sends shoppers' events from the browser or app, its catalog and campaigns from its backend (the retail API), and server-side identity (sign-in, erasure). Outside the platform. |
| **Edge** | gateway, auth-service | Routing, per-IP limits, CORS per tenant's allowed origins; API keys, visitor, shopper, integration and access tokens. |
| **Ingestion** | ingestion-service | Validates each event, refuses bot traffic, holds each tenant to its budget, publishes to Kafka. |
| **Stream** | Kafka | `retail.interactions.v1` (impressions, clicks, views, add-to-cart, …; 14 days), identity events, and compacted catalog, campaign, campaign-product and tenant topics. Shared by every tenant. |
| **Processing** | Flink (SQL) | Validated ad events, click→basket attribution (7-day stateful join), user sessions (event-time session window). Writes three serving topics. |
| **Serving** | ClickHouse, insights-service | Daily aggregates per tenant, store, campaign and day, kept forever; the `/ad` API reads them as a user that sees one tenant per query. |
| **Data lake** | Kafka Connect → Apache Iceberg on S3 | Every topic, every tenant, as typed Iceberg tables: the system of record. |
| **Batch** | Airflow | History backfills from the lake, ClickHouse backups, tenant and shopper purges from the lake. |
| **Observability** | Prometheus, Grafana, alerts; Loki and Alloy for logs | Every layer above. |

```
site / app ─► gateway ─► ingestion-service ─► Kafka ─┬─► Flink ─► serving topics ─► ClickHouse (staging 3 d → daily tables) ─► insights-service ─► /ad
                                                     └─► Kafka Connect ─► Iceberg on S3 (all topics, forever) ─► history backfill ─┘
```

## 2. Technology choices

| Need | Choice | Why | Considered |
|---|---|---|---|
| High-velocity ingestion with low latency | **Stateless Node.js service** behind the gateway, publishing to **Kafka** | Validation and auth in ~10 ms p50; Kafka absorbs bursts and decouples producers from every consumer (Flink, Connect, ClickHouse) | Kinesis (fewer knobs on AWS, but per-shard limits and 7-day max retention); writing straight to the database (no buffer, no replay) |
| Event bus | **Apache Kafka** (MSK on AWS) | Replay (14 days), ordering per key, consumer groups for independent readers, compacted topics for reference data | Kinesis, Pulsar |
| Stream processing with state | **Apache Flink (SQL)** | Exactly-once state with checkpoints, keyed state in RocksDB for joins and windows, event time and watermarks, SQL a reviewer can read | Kafka Streams (state per app instance, harder to scale state independently); Spark Structured Streaming (micro-batches; its watermark dropped late joins in an earlier version of this repo) |
| Serving store for live and historical queries | **ClickHouse** | Columnar, sub-second aggregations, materialized views that aggregate on insert, `AggregatingMergeTree` for mergeable distinct-count sketches, row policies for tenant isolation | Druid/Pinot (similar, more moving parts); Cassandra/DynamoDB (fast key reads but every aggregation precomputed in code, no ad-hoc ranges); Snowflake (seconds and per-query cost for a dashboard read) |
| Raw events, forever | **Apache Iceberg on S3**, written by **Kafka Connect** (Iceberg sink) | Open table format any engine reads (ClickHouse, Athena, Trino, Spark, Snowflake), cheap tiered storage, row-level deletes for erasure, schema evolution | Raw JSON files (no deletes or schema), keeping raw rows in ClickHouse (duplicates the lake, needs its own retention and erasure) |
| Batch orchestration | **Airflow** | Backfills, backups and purges as DAGs with retries, parameters and history | Cron (no history or retries), Step Functions |
| Metrics, alerts, logs | **Prometheus, Grafana, Alertmanager; Loki** | Open, Kubernetes-native; one dashboard for the whole path | CloudWatch / Datadog (managed, cost per metric) |
| Deployment | **Kubernetes (EKS), one Helm chart per service**, Flink Kubernetes Operator | Independent releases and rollbacks, autoscaling per service | ECS |

## 3. Event ingestion

- **Clients** batch events (1–100 per request) through the SDK. A shopper's events carry a token that fixes the tenant, user and user type; the SDK keeps a visitor's UUID across sign-in, so a visitor who signs in stays one user.
- **ingestion-service** checks the sender (bot user agents are refused and counted per tenant), the format, the timestamp (at most 2 days old, 5 minutes ahead), the campaign (active, of the sender's tenant), the rate (per sender, and per tenant by tier), then publishes to Kafka and answers. It doesn't wait for processing.
- **Latency:** on one laptop with the whole stack, ingestion p99 is 58 ms at 1,000 events/s, and an event is in the `/ad` numbers 7.5 s later (p50; 22 s p99) ([`basketline/loadtest/README.md`](../basketline/loadtest/README.md)).
- **Partitioning:** interactions are keyed by event ID, so every tenant's events spread over all partitions: no hot partition whatever the tenant mix. Stateful grouping happens in Flink, not by Kafka key. Size partitions for the peak (e.g. 48 for 100k events/s).

## 4. Real-time processing and state

One Flink SQL job reads `retail.interactions.v1` once and runs three pipelines in one statement set, so one checkpoint covers the offsets and all state ([`basketline/flink/README.md`](../basketline/flink/README.md)):

| Pipeline | State, keyed by | Output |
|---|---|---|
| Ad events | none: validation and projection | `serving.events.v1`: impressions and clicks with a campaign |
| **Click → basket attribution** | a regular join keyed by `(tenant, user, product)`: clicks kept 13 days, basket additions 6 days (`STATE_TTL`) | `serving.attributed_baskets.v1`: every (basket addition, candidate click in the 7 days before); ClickHouse credits the latest click |
| **User sessions** | an event-time `SESSION` window keyed by `(tenant, user)`, 30-minute gap; state is each user's open session | `serving.sessions.v1`: one row per session, with the campaigns it saw, the clicks and the products added |

**Tracking user sessions across events.** The session window holds each user's open session in keyed state (RocksDB) and merges events into it while they come less than 30 minutes apart. The source's watermark trails the newest event time by 10 minutes. Once it passes a session's last event + 30 minutes, Flink writes the session and drops its state. The SDK keeps a visitor's UUID across sign-in, so browsing as a visitor and buying signed in is one session, across pages, stores and web/mobile. ClickHouse counts the sessions that saw each campaign and the **converted** ones: those that added to the cart a product clicked in that campaign.

**Why two different time models.**
- The attribution join is a *regular* join, not an event-time window. Either event may arrive first, up to 2 days late, and still match, and nothing is dropped. That is the accuracy-critical metric.
- Sessions need event time to know when a session has ended. An event more than 10 minutes behind the watermark is left out of its session only, and counted (`numLateRecordsDropped`, alert `LateRecordsDropped`). The history backfill later rebuilds sessions from the lake with late events included.

**Delivery** is at least once end to end. Exact counts come from IDs:
- staging tables keyed by event or session ID merge copies;
- customer and session counts are sketches of IDs;
- an hourly check recounts recent days exactly.

## 5. Storage and retention

| Data | Where | Kept | Why |
|---|---|---|---|
| Raw events, catalog, campaigns, identity | Kafka | 14 days (reference topics compacted) | Replay for Flink and ClickHouse after an outage or a bug fix |
| Serving topics | Kafka | 48 hours | Buffer while ClickHouse is down |
| Flink's output (ad events, credited baskets, sessions) | ClickHouse staging tables | 3 days | Long enough for late events (2 days) and the hourly exact recount |
| **Daily aggregates** per tenant, store, campaign, day | ClickHouse (`SummingMergeTree` counts, `AggregatingMergeTree` sketches) | Forever (tiny: one row per campaign per day) | Every `/ad` query, any range |
| **Everything raw, every tenant** | Iceberg on S3 (the lake), partitioned by tenant and hour | Forever, tiered: S3 Standard → Infrequent Access (30 d) → Glacier Instant Retrieval (180 d) | System of record: recompute, new metrics, analysts, ML |
| Backups | S3 | Daily ClickHouse backups of what the lake can't rebuild (daily tables, erasure records, backfill runs) | Disaster recovery |

**Real-time and batch from one design.** ClickHouse serves both live and historical numbers with millisecond reads. The lake is where batch analytics and recomputation read. S3 is never on the `/ad` API's path: a read there would cost per scan and take seconds.

**Corrections and new metrics without raw data in ClickHouse.** The history backfill (`airflow/jobs/backfill_daily.py`) reads the lake from ClickHouse (`icebergS3`). It recomputes whole days into a scratch database built from the live schema, so the same materialized views count them. Then it swaps each month in atomically (`REPLACE PARTITION`), keeping the replaced month for rollback. A new aggregate table is a new table plus view, and its history is one backfill run.

## 6. Insights API

`GET /api/v1/ad/{campaignId}/{metric}?from&to&storeId`, for campaign managers:

| Metric | Answers | Response |
|---|---|---|
| `clicks` | customers who clicked the ad | `customers` (distinct users), `count` (clicks, for CTR), per client and user type |
| `impressions` | customers who viewed the ad | the same |
| `clickToBasket` | customers who added a product to the cart after clicking the ad (same product, within 7 days, last click) | the same |
| `uniqueCustomers` | everyone who saw or clicked | split web/mobile/both, registered/visitor |
| `sessions` | sessions that saw the ad, and converted in the same session | `total_sessions`, web, mobile, `total_converted_sessions` |

- **Real-time and historical in one query.** The daily tables are updated as rows are stored (seconds), corrected hourly, and kept forever, so "today" and "last year" are the same query over different days. A year is 365 small rows per campaign and store.
- **Performance:**
  - reads follow the tables' sort key (tenant, store, campaign, day);
  - distinct counts are `uniqCombined64` sketches merged across days and stores, exact up to a few thousand and within about 1% above;
  - identical requests share one query and are cached for 15 s.
  - Measured: 60 ms p99 at 40 reads/s on one laptop.
- **Reliability:**
  - every query is bounded (10 s, 4 threads, 2 GB), so one tenant's long range can't take every core;
  - insights-service has no Kafka or write access, so ingestion load can't slow it;
  - ClickHouse keeps serving when Flink or Kafka is down, with older data.

## 7. Scalability and peak events

The rule: **a tenant's load spreads across the platform, and each tenant is capped at its share**, so a busy tenant uses more machines rather than one machine's all.

| Layer | How it scales horizontally | What caps a tenant |
|---|---|---|
| Gateway, ingestion, insights | Stateless pods behind the load balancer, HPA on CPU. About 250 requests/s (2,250 events/s) per ingestion process, measured; scale is pods | Per-IP and per-sender limits; **per-tenant budget by tier** (free 1k, pro 10k, enterprise 100k events/s), `429` with `Retry-After` |
| Kafka | Partitions keyed by event ID; add brokers and partitions | Ingestion budget is the gate; 14 days absorbs bursts |
| Flink | Keyed state spreads each tenant's users over every task; the Flink Kubernetes Operator's autoscaler adds parallelism on consumer lag | Input already capped |
| ClickHouse | Batched inserts from Kafka; shard by `cityHash64(tenant_id)` and replicate; reads hit tiny daily tables | Per-query limits above |
| Lake | S3 and Kafka Connect tasks (one per partition) | — |

**Peak events (e.g. Black Friday).**
- Pre-scale ingestion pods and Flink parallelism ahead of the peak; partitions are already sized for it.
- Kafka buffers whatever the consumers can't keep up with. The `/ad` numbers are then a little behind (consumer-lag panel and alert), but nothing is lost.
- Clients retry `429`s once after `Retry-After`.

**Known limit:** tenant budgets are counted per pod, so N pods give a tenant N× its budget. A shared counter (Redis) would make it exact.

## 8. Metrics and monitoring

| What | Metric | Alert |
|---|---|---|
| API health (RED) | requests/s, 5xx rate, p99 per service and route | 5xx > 5%; ingestion p99 > 500 ms; `/ad` p99 > 1 s |
| Freshness | age of the newest stored event; consumer lag per group | lag growing; ClickHouse Kafka errors |
| Processing | Flink uptime, restarts, failed checkpoints, records in/out, late events | job down or restarting; checkpoints failing; late events dropped |
| Accuracy | hourly check's last success and failures | check failing or stale |
| Durability | age of the newest backup | no backup for 26 h |
| Per tenant | impressions and clicks per store in the last hour; refused bot traffic | — |
| Runtime | Node event-loop lag; ClickHouse's own metrics | any scrape target down |

Tools:
- **Prometheus** scrapes every service's `/metrics`, Flink's reporter, ClickHouse and a Kafka lag exporter.
- **Grafana** has one pipeline dashboard.
- **Alertmanager** routes alerts to a pager on AWS.
- **Logs:** structured JSON (pino) with tenant and request IDs, shipped by Alloy to **Loki**.
- **Diagnostics:** the Flink UI (backpressure, checkpoints), ClickHouse's `system.query_log`, and Airflow's task logs.

## 9. Multi-tenancy

**Isolation by design, enforced in more than one place:**

1. **Identity:** every token carries the tenant. ingestion-service takes the tenant, user and user type from the token, never from the body; a mismatch rejects the batch.
2. **Data:** every row, in every table and topic, has `tenant_id`. In ClickHouse, insights-service reads as `basketline_reader`, whose **row policy** returns only the tenant named in the query's settings. A query that forgets its tenant filter still can't read another tenant's rows; one with no tenant reads nothing.
3. **Lake:** partitioned by tenant, so a tenant's export, deletion or residency move touches only its files. Tenants with contractual isolation get their own bucket, namespace and KMS key.
4. **Deletion and erasure:** a deleted tenant's rows go from ClickHouse at once and from the lake by the purge job. An erased shopper's rows go from staging and the lake. Replays can't bring them back: the Kafka queue views and the backfill skip them.

**Tenant-specific configuration:**
- the account tier sets the ingestion budget;
- the allowed origins set CORS per tenant;
- API keys and integration tokens per tenant;
- campaigns and stores come from the tenant's own retail API.

**Resource allocation:**
- per-tenant ingestion budgets by tier;
- per-query read limits;
- for the very largest tenants: a dedicated ClickHouse shard (the sharding key can place a tenant), an ingestion node pool or a topic of their own. That is configuration, not code.

## 10. Challenges and trade-offs

| Challenge | Choice | Trade-off |
|---|---|---|
| **Real-time vs accurate counts** | Live views count each batch as it lands; an hourly check recounts recent days exactly from staging; the backfill recomputes any settled day from the lake | A day's number can be slightly high (a redelivered event) for up to an hour, then exact |
| **Late and out-of-order events** | Attribution: regular join, no watermark, nothing dropped. Sessions: 10-minute watermark | Sessions are about 40 minutes behind and exclude very late events until a backfill |
| **Distinct counts at scale** | `uniqCombined64` sketches, mergeable across days, stores and client types | ~1% error above a few thousand customers; event counts stay exact |
| **Attribution correctness** | Flink emits every candidate click; ClickHouse picks the latest | More rows than credits; an append-only stream without retractions |
| **Exactly once** | At least once plus idempotent storage (IDs, sketches, hourly recount) | Simpler and cheaper than transactional sinks end to end |
| **Changing the streaming job** | Stateful SQL upgrades can't always restore old state | Restart from committed offsets and backfill the affected days; pin the plan (`COMPILE PLAN`) when changes become frequent |
| **Hot tenants** | Key by event ID and spread state by user | Per-tenant ordering isn't kept (not needed) |

## 11. Cost

**Where the money goes, and how each is kept down:**

| Component | Cost driver | Lever |
|---|---|---|
| Kafka | Retention × throughput | 14 days on raw topics, 48 h on serving topics; tiered storage on MSK for longer |
| Flink | State size, parallelism | State TTLs bound the join; autoscale on lag rather than provision for peak |
| ClickHouse | Storage and CPU | Only aggregates kept long-term (one row per campaign per day); raw rows 3 days. Reads are tiny |
| Lake | S3 storage | Columnar Parquet, lifecycle tiers (about 2× cheaper in IA, 6× in Glacier IR), compaction of small files |
| Compute | Pods | HPA and Karpenter/spot node pools for stateless services |

**Continuous cost monitoring (proposed, not built):**
- **Per component:** AWS cost-allocation tags per service and namespace, and Kubecost/OpenCost for pod-level cost. AWS Budgets and Cost Anomaly Detection alert on spikes.
- **Per tenant (showback):** each driver measured per tenant:
  - events ingested per day (ingestion metrics by tenant);
  - lake bytes (Iceberg metadata per tenant partition);
  - `/ad` queries and their read bytes (ClickHouse `query_log`, which records each query's tenant setting).

  A daily Airflow job writes them to a cost table and a Grafana panel, so the cost per tenant and per 1M events is visible next to its tier.
- **Unit-cost alert:** cost per 1M events above a threshold, which catches regressions such as a bigger state, a longer retention or a new heavy query.

## 12. Extending the design

- **A new metric** (e.g. add-to-cart after impression): a daily table plus a materialized view in ClickHouse, a Flink pipeline only if it needs state. Live counts start at deploy, and its history is one `history_backfill --table <new>` run from the lake.
- **Purchase or revenue attribution:** a `purchase` event joined like `add_to_cart`, with revenue summed per credited click. The same join and window, a new serving topic.
- **Per-tenant attribution windows:** keep candidates for the longest window in Flink and filter by each tenant's window in ClickHouse.
- **Multi-touch attribution:** the candidates are already all written; a view can weigh them (linear, time-decay) instead of picking the latest.
- **Analysts and ML:** query the lake with Athena, Trino or Snowflake external tables, and build features from it, without touching the serving path.
- **More regions:** a regional stack per data-residency zone, with tenants pinned to theirs.
