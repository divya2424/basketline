# Basketline: Flink job (Kafka → Flink SQL → Kafka → ClickHouse)

A Flink SQL job ([`sql/`](sql/)) that reads the topic ingestion-service publishes shoppers' interactions to (`retail.interactions.v1`, every tenant's) and writes three serving topics, which ClickHouse loads into short-lived staging tables ([`../infra/clickhouse/03_kafka.sql`](../infra/clickhouse/03_kafka.sql)); materialized views turn them into the daily tables `/ad` reads. Identity events, campaigns, products and the catalog don't go through Flink: Kafka Connect writes every topic to the data lake ([`../connect/`](../connect/)).

| Topic | One message per | ClickHouse staging table (3 days) | Daily table it feeds |
|---|---|---|---|
| `serving.events.v1` | ad impression or click | `analytics.events` | `daily_campaign_aggregation`, `daily_campaign_customers_aggregation` |
| `serving.attributed_baskets.v1` | (basket addition, candidate click) | `analytics.attributed_baskets` | the same two (click-to-basket) |
| `serving.sessions.v1` | user session | `analytics.sessions` | `daily_campaign_sessions_aggregation` |

Every row carries the tenant and the store the event happened in (the zero store for events from before stores).

```
retail.interactions.v1 ──► parse + validate ──┬─────────────────────────────────────────────► serving.events.v1 ─────────────► analytics.events
                                               │
                                               ├─► clicks ⋈ add_to_cart, keyed by           ► serving.attributed_baskets.v1 ─► analytics.attributed_baskets
                                               │   (tenant, user, product), 7 days              (ClickHouse credits the latest click)
                                               │
                                               └─► SESSION window, keyed by (tenant, user), ► serving.sessions.v1 ───────────► analytics.sessions
                                                   30-minute gap (event time, watermark − 10 min)
```

**Where the state is, and its key.** Flink SQL has no `keyBy()`: it keys each stateful operator by its equality or partition columns, and the job graph (http://localhost:8081) shows them as `hash[…]` edges.

| Requirement | Key (`keyBy` equivalent) | Why this key |
|---|---|---|
| Click-to-basket attribution | `(tenant_id, user_id, product_id)`: the join's equality columns | A user's clicks and basket additions of a product meet on one task, and each key holds only that user's clicks on that product. The product spreads one heavy user's state over tasks. |
| User sessions | `(tenant_id, user_id)`: the window's `PARTITION BY` | A user's events across pages, stores and apps form one session; the state is only their open session. |
| Campaign impressions, clicks, customers | none in Flink | Counted in ClickHouse as rows are stored: keying by campaign in Flink would send a big campaign's whole traffic to one task. |

## Layout

The job is split by role into files under `sql/`. [`run.sh`](run.sh) assembles them into **one job** at startup, in this order:

```
sql/
  settings.sql                              checkpointing, state backend, time zone, source idle timeout
  connectors/                               one file per external table (CREATE TABLE … WITH connector)
    analytics_events.source.sql             Kafka retail.interactions.v1 (read), with the event-time watermark
    serving_events.sink.sql                 Kafka serving.events.v1 (write)
    serving_attributed_baskets.sink.sql     Kafka serving.attributed_baskets.v1 (write)
    serving_sessions.sink.sql               Kafka serving.sessions.v1 (write)
  views/                                    transformations; numbered, since each builds on the ones before
    01_parsed.sql  02_events.sql  03_clicks_and_baskets.sql  04_session_events.sql
  pipelines/                                the INSERTs; run.sh wraps them all in one statement set
    01_serving_events.sql  02_attributed_baskets.sql  03_sessions.sql
```

**Why one job and not one per pipeline.** In one statement set, Flink reads the topic once and feeds every pipeline from that read, and one checkpoint covers the offsets, the join state, the open sessions and every sink, so they recover as a unit. Split a pipeline into its own job only when it needs its own failure domain or scaling.

**Adding things.**
- **A new connector:** a file in `connectors/` (`<name>.source.sql` or `<name>.sink.sql`). Put environment-specific values in `__PLACEHOLDERS__` and add the `sed` line in `run.sh`.
- **A new view:** the next number in `views/`, after the views it reads.
- **A new pipeline:** the next number in `pipelines/`, with just the `INSERT … SELECT …;`.

**Keeping the checkpoint restorable.** Flink matches saved state to operators by IDs it derives from the job graph. Adding a pipeline, a view that feeds one, or a watermark changes the graph, and the new job can't restore the old checkpoint ("Cannot map checkpoint/savepoint state …"): reset it (below). Editing comments or moving text between files doesn't. When the job starts changing often, pin the plan with `COMPILE PLAN … ; EXECUTE PLAN …`, so operator IDs stay stable across upgrades.

## Why Flink, and why through Kafka

- **Stateful work where the events arrive.** Crediting a basket addition to a click needs both events, and a session needs all of a user's events; Flink keeps each in keyed state and emits each result once, so ClickHouse only counts.
- **Any arrival order for attribution.** The join is a *regular* join, not an event-time window: each side waits in state for the other, so a basket published before its click, or a click that arrives days late, still matches. It takes no time attribute, so nothing is dropped as "too late". Only the session window uses event time (below).
- **Through Kafka, not straight into ClickHouse.**
  - A ClickHouse outage doesn't stop the job: Kafka buffers the serving topics (48 hours) until ClickHouse reads them again.
  - Flink SQL has no official ClickHouse sink (ClickHouse's own supports only the DataStream API so far). Once it does, a sink file in `connectors/` can replace this hop.
  - The serving topics can feed other stores later without touching the job.

## Attribution rules

Clients send no attribution: an `add_to_cart` is matched with every `click` that:

1. is of the same tenant, by the same `user_id` (a shopper keeps their visitor UUID when they sign in, through the shopper token, so a click made as a visitor matches a basket addition after signing in);
2. was for the same product (a click without a product is never credited);
3. came at most **7 days** before the basket addition (`event_time`, the user's own time), and not after it.

Flink writes each match (one row per basket addition and candidate click). **The latest click wins** (last click): ClickHouse credits the one with the largest `(click_time, click_event_id)` per basket addition. Flink can't pick it itself and still write an append-only stream: a click that arrives late would have to retract a match already written, which needs an upsert sink. The basket addition is counted under its own store and client type.

**The same rules in the history backfill.** [`airflow/jobs/backfill_daily.py`](../airflow/jobs/backfill_daily.py) recomputes past days from the data lake with the same rules in ClickHouse SQL, so a rule change here must change it too. [`test/fixtures/attribution_cases.json`](../test/fixtures/attribution_cases.json) runs the same cases through both (`pnpm test:flink`, `pnpm test:airflow`).

**Why 7 days.** Retail media networks credit purchases days after a click (Amazon Ads and Walmart Connect use 14-day windows); 24 hours missed shoppers who come back later. The window is one constant in [`02_attributed_baskets.sql`](sql/pipelines/02_attributed_baskets.sql).

**State size.** Kept only as long as a match is still possible (`STATE_TTL`), since this join is most of the job's state:
- **Clicks: 13 days after they arrive.** ingestion-service accepts events up to 2 days old (5 before, kept as margin), the window adds 7, and one day of slack covers the job being down or behind, since the TTL counts wall-clock time.
- **Basket additions: 6 days.** A basket addition only waits for a click from before it that arrives late (at most 2 days, with the same margin).
- Only clicks that can be credited are held (on a campaign, with a product, by a known user: `views/03_clicks_and_baskets.sql`).

The state is in RocksDB, checkpointed incrementally, and each checkpoint is also kept on the task manager's disk, so a failed task restores locally (`settings.sql`).

## Sessions

[`03_sessions.sql`](sql/pipelines/03_sessions.sql): a user's interactions (per tenant) with no gap of **30 minutes** or more form one session, an event-time `SESSION` window partitioned by `(tenant_id, user_id)`. 30 minutes is the usual web-analytics inactivity timeout. Each session is one row: start, end, event count, user type (registered if any event was), web/mobile, the `store:campaign` pairs it saw or clicked, its clicks' `campaign:product` pairs and the products it added to the cart. ClickHouse counts per day, store and campaign the sessions that saw or clicked it, per client type, and the **converted** ones: those that added a product they clicked in that campaign (`/ad/:id/sessions`).

- **Event time and the watermark.** A session window needs to know when no more events of a session can come. The source's watermark trails the newest event time by **10 minutes** (`analytics_events.source.sql`), so a session is written about 40 minutes after its last event (30-minute gap + 10). A partition with no events for a minute stops holding the watermark back (`table.exec.source.idle-timeout`). When the whole topic is quiet, nothing moves the watermark, so the last sessions stay open until the next event arrives: never an issue with production traffic, visible on an idle local stack.
- **Late events are left out of sessions only.** An event more than 10 minutes older than the newest one seen (a phone that was offline) is dropped from sessions but still counted everywhere else. Flink's `numLateRecordsDropped` counts them (Grafana panel and alert `LateRecordsDropped`). The history backfill rebuilds a settled day's sessions from the data lake, late events included.
- **Only the session window uses event time.** The watermark is on the shared source, but the attribution join and the events pipeline take no time attribute, so they never drop anything.
- **Attribution doesn't depend on sessions.** The 7-day window spans sessions on purpose, so a shopper who comes back the next day is credited; sessions add the same-session conversion next to it.
- **Duplicates.** At least once, like the rest: a session written again after a restart has the same `(tenant, user, start)`, so the same `session_id`, and its sketches count it once.
- The aggregation is in the pipeline's `INSERT`, not a view: Flink fails to expand a view holding a partitioned session window.
- **Checking it live.** `test:flink` doesn't cover sessions: on a shared stack, closing one needs a future-dated event, which would make real events late. Publish a user's events (e.g. an impression, a click and an `add_to_cart` an hour ago) and one event at the current time, then read `analytics.sessions` a minute later. The window's SQL and the 30-minute rule are tested through the history backfill (`airflow/tests/test_backfill_daily.py`) and the ClickHouse views through insights-service's tests.

## Delivery and duplicates

- **Checkpoints every 60 s** hold the Kafka offsets, the join state and the open sessions (RocksDB, incremental), kept when the job stops (`RETAIN_ON_CANCELLATION`). Rows are written as they are processed, so the interval doesn't delay them; it only bounds how much is read again after a restart.
- **After a crash**, Flink retries the failed tasks from the last checkpoint (`restart-strategy` in [`config.yaml`](config.yaml)). **After a container restart**, [`run.sh`](run.sh) resumes from the newest complete checkpoint in `CHECKPOINT_DIR`, in `CLAIM` mode.
- **At least once:** what was written after the last checkpoint is written again after a restart. ClickHouse absorbs it: the staging tables are `ReplacingMergeTree` keyed down to the event (or session) IDs, customer and session counts are sketches of IDs, and the hourly check recounts the event totals of recent days exactly (`basketline/README.md`, "Daily totals").
- **Malformed records** (invalid JSON, or a missing or non-UUID `eventId`, `tenantId` or `timestamp`) are dropped. An optional ID that isn't a UUID becomes `NULL`. ingestion-service already validates events, so this only guards the sinks.

## Run it

`../docker-compose.yml` runs it as `flink-streaming`. The Flink web UI (job graph, checkpoints, backpressure) is at http://localhost:8081.

```bash
docker compose up -d --build flink-streaming
docker compose logs -f flink-streaming        # "Job ID: …", then "Restoring from …" after a restart
```

**Test:** `pnpm test:flink` (from `basketline/`, with the stack up) publishes impressions, clicks and baskets to the real topic and checks in ClickHouse that each reached its staging table with its store, and that exactly the baskets the rules allow were credited, including one whose click is published after it.

## Resetting the checkpoint

When the job's graph changes (above), the new job fails with a state restore error. Set the old checkpoints aside and start from the offsets Flink committed at its last checkpoint, so nothing is read twice or skipped:

```bash
docker compose stop flink-streaming
docker compose run --rm --no-deps --entrypoint sh flink-streaming -c \
  'mkdir -p /checkpoints/old && for d in /checkpoints/*; do [ "$d" = /checkpoints/old ] || mv "$d" /checkpoints/old/; done'
KAFKA_STARTUP_MODE=group-offsets docker compose up -d flink-streaming
```

What the old state held is lost: clicks still waiting for a basket addition (so a basket added in the next 7 days isn't credited to a click from before the reset) and open sessions. Once those days are settled (3 days), the history backfill recomputes them from the data lake: `airflow/jobs/backfill_daily.py --from <reset day> --to <reset day + 7>`. Without `group-offsets`, the job replays everything Kafka keeps (14 days) from `earliest-offset`, which would add those days to the daily totals again.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Brokers (`kafka:19092` inside compose) |
| `KAFKA_TOPIC_PREFIX` | empty | Must match ingestion-service's `KAFKA_TOPIC_PREFIX`. `03_kafka.sql` reads unprefixed topics |
| `KAFKA_GROUP_ID` | `events-to-clickhouse` | The consumer group Flink commits offsets to at each checkpoint (lag monitoring, `group-offsets` starts) |
| `KAFKA_STARTUP_MODE` | `earliest-offset` | Used only when there is no checkpoint: `earliest-offset`, `latest-offset` or `group-offsets` |
| `CHECKPOINT_DIR` | `/checkpoints` | Keep it on a persistent volume; never share it between jobs |

Memory, task slots and parallelism are set in [`config.yaml`](config.yaml). Prometheus scrapes the job manager on `:9249` and the task manager on `:9250` (the [README](../README.md#monitoring)).
