# Basketline: load test (analytics p99)

Measures three p99s for the analytics path:

| What | How it's measured |
|---|---|
| **Ingestion latency** | k6 timing of `POST /api/v1/analytics/events` through the gateway: gateway → ingestion-service → Kafka ack |
| **Dashboard read latency** | k6 timing of `GET /api/v1/ad/{campaign}/{metric}?from=…` (random metric, random 7/30/90/365-day range) |
| **End-to-end freshness** | In ClickHouse, `ingested_at − received_at` for **every** event of a run (`freshness.sql`): Kafka, the Flink job and ClickHouse's Kafka reads |

**Load model:** browser-like batches. Each ingestion request carries 9 events (6 impressions, 2 clicks, 1 add-to-cart of the first click's product, which Flink credits to that click), so 1M events/s is about 111k requests/s. Test events go to the load-test tenant `0ad7e570-0000-4000-8000-000000000001` with `properties.loadtest_run = <run id>`, which keeps them apart from real data. They are sent by visitors, each with its own visitor token (a new one every 25 batches, below the 300 events per sender per minute), on the load-test tenant's active campaigns (seeded as `loadtest`); the dashboard scenario reads them as the `loadtest` campaign manager, whose tenant is the load-test tenant.

## Files

- `analytics.js`: the k6 script. One run is one fixed rate. Settings (environment variables):
  - `RATE`: ingestion requests/s;
  - `READ_RATE`: dashboard reads/s (`0` leaves a scenario out);
  - `DURATION`, `RUN_ID`, `BASE_URL`, `LOADTEST_USERNAME`, `LOADTEST_PASSWORD`.

  Targets: ingestion p99 < 500 ms, reads p99 < 1 s, errors < 1%.
- `run.sh`: runs `analytics.js` once per rate in `RATES`, then prints that run's freshness.
- `freshness.sql`: the freshness p99 for one run.
- `cleanup.sql`: deletes all test events from ClickHouse. They stay in Kafka until retention ends, so a Flink checkpoint reset would load them again.

## Run it locally

From `basketline/`, with the stack up. Create the load-test tenant once: an `onboarding` campaign manager, so `seed-tenant` can seed its sellers, products and campaigns (and send them to the retail API, so analytics knows the campaigns), and the `loadtest` user the script signs in as. `pnpm seed` adds the sample catalog's campaigns:

```bash
cli() { docker compose exec auth-service node basketline/services/auth-service/src/cli.ts "$@"; }
T=0ad7e570-0000-4000-8000-000000000001
cli create-account --name 'Load test' --tenant $T
cli create-user --username onboarding --password 'load test password' --role campaign-manager --tenant $T
cli seed-tenant --tenant $T
cli create-user --username loadtest --password 'load test password' --role campaign-manager --tenant $T
SEED_USERNAME=loadtest SEED_PASSWORD='load test password' SEED_TENANT=$T pnpm seed
```

The gateway limits each client IP to 300 requests/min (120 for event posts, 10 visitor tokens). One k6 machine is one IP, so raise the limits for the test, and put them back afterwards:

```bash
RATE_LIMIT_PER_MINUTE=100000000 EVENTS_RATE_LIMIT_PER_MINUTE=100000000 VISITOR_RATE_LIMIT_PER_MINUTE=100000000 \
  docker compose up -d gateway
RATES="50 100 250 500 1000" READ_RATE=0 loadtest/run.sh       # ingestion ladder + freshness
docker run --rm -i --network basketline_default -e RATE=0 -e READ_RATE=10 \
  grafana/k6:1.3.0 run -q - < loadtest/analytics.js            # dashboard reads only
docker compose up -d gateway                                   # back to the default limits
docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev \
  --multiquery < loadtest/cleanup.sql
```

Each run prints one JSON line with p50, p95 and p99 per scenario, the rate achieved, the failure percentage and the dropped iterations (requests k6 couldn't start because earlier ones hadn't returned). A run below its target rate is overloaded, and its p99 includes queueing.

## Results (2026-11-02, one laptop, with Flink)

Docker Desktop with **12 vCPUs and 8 GB**, and **everything on that one machine**: k6, the gateway, 4 services, Kafka (one broker, 3 partitions), Flink (one container, parallelism 2, also writing the Iceberg archive), ClickHouse, Postgres, Airflow and the monitoring stack. These numbers describe that machine, not a production deployment. Each run is 60 s; freshness is measured 75 s after it ends.

**Ingestion** (no reads running; 9 events per request):

| Target req/s (events/s) | Achieved req/s | p50 | p95 | **p99** | Failed | Freshness p50 / **p99** |
|---|---|---|---|---|---|---|
| 50 (500) | 51 | 11 ms | 74 ms | **569 ms** | 0% | 49 s / 131 s ¹ |
| 100 (1k) | 104 | 9 ms | 20 ms | **58 ms** | 0% | 7.5 s / **22 s** |
| 250 (2.5k) | 256 | 23 ms | 462 ms | **625 ms** | 0% | 23 s / **64 s** |
| 500 (5k) | 196 | 3.2 s | 25 s | **43 s** | 7.5% | 34 s / 73 s |
| 1,000 (10k) | 127 | 1.2 s | 27 s | **49 s** | 47% ² | 13 s / 40 s |

¹ Flink had just been reset and was still replaying Kafka's 14 days while this run was sent.
² Mostly timeouts. The overload then took the gateway and ingestion-service down (below).

**Dashboard reads** (no ingestion; `GET /ad/{campaign}/{metric}`, random metric and 7–365-day range):

| Reads/s | p50 | p95 | **p99** | Failed |
|---|---|---|---|---|
| 10 ³ | 20 ms | 342 ms | **4.5 s** | 0.18% |
| 40 | 6 ms | 34 ms | **60 ms** | 0% |

³ Right after the services restarted, with cold caches and Flink catching up; the 40 reads/s run is the steady state.

**Where the CPU goes at 250 req/s** (`docker stats`, of 12 cores): Flink about 3 cores, Kafka 1–2.4, the gateway 1.2–1.5, ingestion-service 1–1.3, ClickHouse up to 2, k6 0.65.

**What the numbers show** (measured before analytics-service was split into ingestion-service and insights-service; the ingestion figures below are now ingestion-service's):
- **The first bottleneck is the two Node processes.** The gateway and ingestion-service are one process each, and each ran at its one core: about **250 requests/s (2,250 events/s) per process** on this machine. Past that, latency goes to seconds and then requests time out. They scale by adding pods.
- **Flink made the dashboards fresher.** Up to the ingestion limit, events are stored a median 7.5 s after they're sent (p99 22 s) at 1,000 events/s, against 24 s with the earlier Spark loader's 30 s micro-batches (2026-10-28). Most of the rest is ClickHouse's 15 s Kafka flush, kept for cheaper inserts (`infra/clickhouse/03_kafka.sql`).
- **Reads are cheap:** `/ad` reads pre-aggregated daily rows, so 40 reads/s had a 60 ms p99, and the 15 s cache absorbs repeats.
- **Nothing accepted was lost.** Every event the API accepted was stored once; under overload, clients get latency and then timeouts.
- **Found by this test: overload crashed two services.** At 1,000 req/s, Kafka's consumer-group sync failed (`syncGroup failed 4 times`, from the broker starved of CPU). The Kafka client library (`@divya2424/basketline-kafka`) raised it as an uncaught exception, and the gateway and ingestion-service shut down. Compose has no restart policy, so they stayed down (Kubernetes would restart them). The fix belongs in the library: retry and rejoin the group instead of throwing.

**Capacity model** (per-core figures from this laptop, so a conservative first estimate; re-measure on the target machines):

| Component | Measured here | For 100k events/s (≈11k requests/s at 9 events each) |
|---|---|---|
| Gateway | ~250 req/s per process (1 core) | ~45 pods at 1 core, + 30% headroom → **~60** |
| ingestion-service | ~250 req/s per process | **~60 pods** (or batch 50 events per request: ~11) |
| Kafka | 1–2.4 cores at 2.25k events/s (one broker) | 3+ brokers; `retail.interactions.v1` with **≥ 48 partitions** (≈100 MB/s at ~1 KB per event) |
| Flink | ~3 cores at 2.25k events/s, including archive writes | parallelism ≈ partitions (48): task managers on the Flink Kubernetes Operator, RocksDB on local NVMe, checkpoints on S3 |
| ClickHouse | ≤ 2 cores storing 2.25k events/s | 2+ shards × 2 replicas; reads stay small (daily rows) |

The model's main lever is batching: the SDK sends up to 20 events per request, and 50 would cut the gateway and analytics pods by about 5×.

## Getting to 1M events/s (about 111k requests/s)

This is about 1,000× what one laptop handles. These are the changes needed, in order of impact. The per-instance figures need re-measuring on dedicated machines; the laptop figures include contention from co-located services.

1. **More gateway and ingestion-service instances.** Each is one Node process, one core. Run many replicas behind a load balancer, or one process per core with Node's `cluster` module, sized from a per-core measurement on dedicated hardware.
2. **Bigger batches from the client.** 50 events per request instead of 9 means 20k requests/s instead of 111k for the same 1M events/s, which cuts gateway and service work by about 5×.
3. **A Kafka cluster.** Today there's one broker with 3 partitions per topic. 1M messages/s (~0.5–1 GB/s) needs several brokers and hundreds of partitions on `retail.interactions.v1`, which carries every interaction, plus producer batching and compression.
4. **A Flink cluster.** The job runs in one container with parallelism 2. Run it with the Flink Kubernetes Operator: task managers scaled with the busiest topics' partitions, checkpoints on S3, and RocksDB state sized for 13 days of clicks and 6 of basket additions, plus open sessions, on local NVMe (local recovery).
5. **`/ad` already reads aggregates, not raw events.** It reads the daily tables (one row per day, tenant and campaign, kept current by materialized views), so a read's cost doesn't grow with event volume.
6. **Lower freshness, if it matters.** The intervals are now relaxed on purpose, so dashboards are under a minute old at the lowest cost (`basketline/README.md`); lower them again only if a use case needs it. With Flink, events reach ClickHouse within seconds (median 1.6–4.7 s in small idle-laptop runs). Flink itself adds well under a second. The largest share is ClickHouse's Kafka engine, which stores what it has read at least every `stream_flush_interval_ms` (7.5 s by default); lower it with `kafka_flush_interval_ms` on the queue tables (`infra/clickhouse/03_kafka.sql`), at the cost of more, smaller inserts.

**Running the same script at 1M/s:** one k6 instance generates a few thousand requests/s, so 111k/s needs distributed load. Use the [k6 operator](https://grafana.com/docs/k6/latest/testing-guides/running-distributed-tests/) on Kubernetes with `parallelism: N`; each instance runs `RATE = 111000 / N`. **Don't average the instances' p99s;** that gives a wrong number. Send all instances' raw results to one place (`k6 run --out experimental-prometheus-rw`, or Grafana Cloud k6) and compute the p99 there. Run `freshness.sql` unchanged, since ClickHouse already sees every event.
