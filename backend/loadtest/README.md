# Load test: analytics p99

Measures three p99s for the analytics path:

| What | How it's measured |
|---|---|
| **Ingestion latency** | k6 timing of `POST /api/v1/analytics/events` through the gateway: gateway → analytics-service → Kafka ack |
| **Dashboard read latency** | k6 timing of `GET /api/v1/ad/{campaign}/{metric}?from=…` (random metric, random 7/30/90/365-day range) |
| **End-to-end freshness** | In ClickHouse, `ingested_at − received_at` for **every** event of a run (`freshness.sql`): Kafka plus the Spark micro-batch |

**Load model:** browser-like batches. Each ingestion request carries 10 events (6 impressions, 2 clicks, 1 credited click-to-basket, 1 add-to-cart), so 1M events/s is 100k requests/s. Test events go to the load-test tenant `0ad7e570-0000-4000-8000-000000000001` with `properties.loadtest_run = <run id>`, which keeps them apart from real data. They are sent by visitors, each with its own visitor token (a new one every 25 batches, below the 300 events per sender per minute), on the load-test tenant's active campaigns (seeded as `loadtest`); the dashboard scenario reads them as the `loadtest` campaign manager, whose tenant is the load-test tenant.

## Files

- `analytics.js`: the k6 script. One run is one fixed rate. Settings (environment variables):
  - `RATE`: ingestion requests/s;
  - `READ_RATE`: dashboard reads/s (`0` leaves a scenario out);
  - `DURATION`, `RUN_ID`, `BASE_URL`, `LOADTEST_USERNAME`, `LOADTEST_PASSWORD`.

  Targets: ingestion p99 < 500 ms, reads p99 < 1 s, errors < 1%.
- `run.sh`: runs `analytics.js` once per rate in `RATES`, then prints that run's freshness.
- `freshness.sql`: the freshness p99 for one run.
- `cleanup.sql`: deletes all test events from ClickHouse. They stay in Kafka until retention ends, so a Spark checkpoint reset would load them again.

## Run it locally

From `backend/`, with the stack up. Create the load-test campaign manager once, and seed its tenant's campaigns (campaigns belong to one tenant):

```bash
docker compose exec auth-service node services/auth-service/src/cli.ts \
  create-account --name 'Load test' --tenant 0ad7e570-0000-4000-8000-000000000001
docker compose exec auth-service node services/auth-service/src/cli.ts \
  create-user --username loadtest --password 'load test password' --role campaign-manager --tenant 0ad7e570-0000-4000-8000-000000000001
SEED_USERNAME=loadtest SEED_PASSWORD='load test password' SEED_TENANT=0ad7e570-0000-4000-8000-000000000001 npm run seed
```

The gateway limits each client IP to 300 requests/min (120 for event posts, 10 visitor tokens). One k6 machine is one IP, so raise the limits for the test, and put them back afterwards:

```bash
RATE_LIMIT_PER_MINUTE=100000000 EVENTS_RATE_LIMIT_PER_MINUTE=100000000 VISITOR_RATE_LIMIT_PER_MINUTE=100000000 \
  docker compose up -d gateway
RATES="50 100 150" READ_RATE=0 loadtest/run.sh                 # ingestion ladder + freshness
docker run --rm -i --network shopsphere_default -e RATE=0 -e READ_RATE=10 \
  grafana/k6:1.3.0 run -q - < loadtest/analytics.js            # dashboard reads only
docker compose up -d gateway                                   # back to the default limits
docker compose exec -T clickhouse clickhouse-client --user shopsphere --password shopsphere_dev \
  --multiquery < loadtest/cleanup.sql
```

Each run prints one JSON line with p50, p95 and p99 per scenario, the rate achieved, the failure percentage and the dropped iterations (requests k6 couldn't start because earlier ones hadn't returned). A run below its target rate is overloaded, and its p99 includes queueing.

## Results (2026-10-28, one laptop)

The environment was Docker Desktop with 12 vCPUs and 8 GB. **Everything shared that one machine:** k6, the gateway, 4 services, Kafka, Spark (`local[2]`), ClickHouse and Postgres. These numbers describe that machine, not a production deployment.

**Ingestion** (no reads running):

| Target req/s (events/s) | Achieved req/s | p50 | p95 | **p99** | Failed | Freshness p50 / **p99** |
|---|---|---|---|---|---|---|
| 20 (200) | 20 | 15 ms | 111 ms | **353 ms** | 0% | 24.5 s / **31.8 s** |
| 100 (1k) | 100 | 4 ms | 6 ms | **14 ms** | 0% | — |
| 150 (1.5k) | 128 | 6 ms | 3.4 s | **4.2 s** | 0% | 23.9 s / **43.7 s** |
| 200 (2k) | 163 | 150 ms | 3.9 s | **5.6 s** | 0% | 26.3 s / **47.1 s** |
| 250 (2.5k) | 217 | 4 ms | 0.9 s | **5.8 s** | 0.02% | 23.9 s / **44.6 s** |
| 500 (5k) | 378 | 2.2 s | 9.7 s | **10.8 s** | 0% | 24.6 s / **42.3 s** |
| 1,000 (10k) | 259 | 11.8 s | 29.8 s | **32.9 s** | 0% | 31.8 s / **48.7 s** |
| 2,000 (20k) | 250 | 8.7 s | 35.7 s | **43.7 s** | 25% (timeouts) | 30.3 s / **66.3 s** |
| 4,000 (40k) | 224 | 8.9 s | 60.0 s | **60.1 s** | 41% (timeouts) | 76.6 s / **96.6 s** |

**Dashboard reads** (no ingestion; up to about 1M test events for today in raw data):

| Reads/s | p50 | p95 | **p99** |
|---|---|---|---|
| 5 | 35 ms | 128 ms | **173 ms** |
| 10 | 36 ms | 87 ms | **177 ms** |
| 40 | 114 ms | 707 ms | **1.13 s** |

A 20 reads/s run gave a 5.1 s p99, but it started while ClickHouse was still storing the backlog from the 4,000 req/s run, so treat it as noise. A separate 20 reads/s run without that backlog gave **421 ms**.

**What the numbers show:**
- **This machine sustains about 100 req/s (1,000 events/s) at an ingestion p99 under 500 ms.** From 150 req/s the median stays at milliseconds but the tail jumps to seconds. The gateway and analytics-service are each a single Node process and sat at 100–145% CPU (one core each). Every 30 s, Spark's micro-batch takes up to 3 cores on the same machine, which stalls them.
- **Nothing was lost or duplicated.** Every accepted event was stored exactly once (`rows_stored = events_stored = accepted × 10`). Under overload, clients see latency and then timeouts; data isn't dropped.
- **Freshness p99 is 32–48 s while the system keeps up.** That's Spark's 30 s trigger plus the batch time. It rises to 66–97 s when Kafka builds a backlog.
- **Running reads and ingestion together hurt ingestion.** With 20 reads/s and 100 req/s ingestion, the ingestion p99 was 3.2 s instead of 14 ms. Each `/ad` read counts yesterday and today from raw events, so it competes for ClickHouse CPU.

## Getting to 1M events/s (100k requests/s)

This is about 1,000× what one laptop handles. These are the changes needed, in order of impact. The per-instance figures need re-measuring on dedicated machines; the laptop figures include contention from co-located services.

1. **More gateway and analytics-service instances.** Each is one Node process, one core. Run many replicas behind a load balancer, or one process per core with Node's `cluster` module, sized from a per-core measurement on dedicated hardware.
2. **Bigger batches from the client.** 50 events per request instead of 10 means 20k requests/s instead of 100k for the same 1M events/s, which cuts gateway and service work by about 5×.
3. **A Kafka cluster.** Today there's one broker with 3 partitions per topic. 1M messages/s (~0.5 GB/s) needs several brokers and tens of partitions on the busiest topics (`analytics.impression.v1` carries 60%), plus producer batching.
4. **A Spark cluster, and a higher batch cap.** `KAFKA_MAX_OFFSETS_PER_TRIGGER` (200k per 30 s trigger) caps Spark at about 6.7k events/s. Raise it to at least 30M per trigger and run on a cluster, not `local[2]`.
5. **`/ad` reads from aggregates, not raw events.** Today `/ad` scans raw events for yesterday and today. At 1M/s that's up to 170B rows, so these reads must come from the hourly aggregates (closed hours), with raw events only for the current hour.
6. **Lower freshness, if it matters.** Freshness is bounded below by `SPARK_TRIGGER_INTERVAL`, currently 30 s.

**Running the same script at 1M/s:** one k6 instance generates a few thousand requests/s, so 100k/s needs distributed load. Use the [k6 operator](https://grafana.com/docs/k6/latest/testing-guides/running-distributed-tests/) on Kubernetes with `parallelism: N`; each instance runs `RATE = 100000 / N`. **Don't average the instances' p99s;** that gives a wrong number. Send all instances' raw results to one place (`k6 run --out experimental-prometheus-rw`, or Grafana Cloud k6) and compute the p99 there. Run `freshness.sql` unchanged, since ClickHouse already sees every event.
