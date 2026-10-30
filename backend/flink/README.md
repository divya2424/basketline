# Basketline: Flink job (Kafka → Flink SQL → Kafka → ClickHouse)

A Flink SQL job ([`sql/`](sql/)) that reads every analytics topic analytics-service publishes to (`analytics.<eventName>.v1`) and writes three topics, which ClickHouse loads ([`../infra/clickhouse/kafka.sql`](../infra/clickhouse/kafka.sql)):

| Topic | One message per | ClickHouse table | Used by |
|---|---|---|---|
| `serving.events.v1` | valid event | `analytics.events` | `daily_campaign_aggregation` (impressions, clicks), read by `/ad` |
| `serving.attributed_baskets.v1` | (basket addition, candidate click) | `analytics.attributed_baskets` | `daily_campaign_aggregation` (click_to_basket) and the click-to-basket customers, read by `/ad` |
| `serving.sessions.v1` | user session | `analytics.sessions` | `daily_campaign_sessions_aggregation`, read by `/ad/:id/sessions` |

```
analytics.<eventName>.v1 ──► parse + validate ──┬──────────────────────────────────────────────► serving.events.v1 ──────────► analytics.events
                                                 │
                                                 ├─► clicks ⋈ add_to_cart, keyed by             ► serving.attributed_baskets.v1 ► analytics.attributed_baskets
                                                 │   (tenant, user, product), 7-day window        (ClickHouse credits the latest click)
                                                 │
                                                 └─► SESSION window, keyed by (tenant, user),   ► serving.sessions.v1 ──────────► analytics.sessions
                                                     6-hour gap (event time, watermark − 1 h)
```

**Where the state is, and its key.** Flink SQL has no `keyBy()`: it keys each stateful operator by its equality or partition columns, and the job graph (http://localhost:8081) shows them as `hash[…]` edges. The two stateful pipelines:

| Requirement | Key (`keyBy` equivalent) | Why this key |
|---|---|---|
| Click-to-basket attribution | `(tenant_id, user_id, product_id)`: the join's equality columns | A user's clicks and basket additions of a product meet on one task, and each key holds only that user's clicks on that product. The product spreads one heavy user's state over tasks. |
| User sessions | `(tenant_id, user_id)`: the window's `PARTITION BY` | A user's events across pages and apps form one session. |
| Campaign impressions, clicks, customers | none in Flink | Counted in ClickHouse as rows are stored (daily tables): keying by campaign in Flink would send a big campaign's whole traffic to one task. |

## Layout

The job is split by role into files under `sql/`. [`run.sh`](run.sh) assembles them into **one job** at startup, in this order:

```
sql/
  settings.sql                              checkpointing, state backend, time zone
  connectors/                               one file per external table (CREATE TABLE … WITH connector)
    analytics_events.source.sql             Kafka analytics.<eventName>.v1 (read)
    serving_events.sink.sql                 Kafka serving.events.v1 (write)
    serving_attributed_baskets.sink.sql     Kafka serving.attributed_baskets.v1 (write)
  views/                                    transformations; numbered, since each builds on the ones before
    01_parsed.sql  02_events.sql  03_clicks_and_baskets.sql
  pipelines/                                one INSERT per file; run.sh wraps them all in one statement set
    01_serving_events.sql  02_attributed_baskets.sql
```

**Why one job and not one per pipeline.** In one statement set, Flink reads the Kafka topics once and feeds every pipeline from that read. One checkpoint also covers the offsets, the join state and every sink together, so they recover as a unit. Separate jobs would read Kafka twice and checkpoint separately. Split a pipeline into its own job only when it needs its own failure domain or scaling.

**Adding things.**
- **A new connector:** add a file to `connectors/` (`<name>.source.sql` or `<name>.sink.sql`). Tables don't depend on each other, so their order doesn't matter. Put environment-specific values in `__PLACEHOLDERS__` and add the `sed` line in `run.sh`.
- **A new view:** add the next number in `views/`, after the views it reads.
- **A new pipeline:** add the next number in `pipelines/`, with just the `INSERT … SELECT …;`.

**Keeping the checkpoint restorable.** Flink matches saved state to the operators of the job's plan. Renaming or reordering the existing `pipelines/` files, or editing a stateful query (the join), can change the plan, and the job then fails to restore. In that case, reset the checkpoint (below). Moving text between files, editing comments or adding a connector doesn't change the plan. When the job starts changing often, pin the plan with `COMPILE PLAN … ; EXECUTE PLAN …`: operator IDs then stay stable across upgrades.

## Why Flink, and why through Kafka

- **Stateful attribution where the events arrive.** Crediting a basket addition to a click needs both events. Flink keeps each user's clicks in state and emits each match once, so the API reads one sorted range, and clients only send what happened (`click`, `add_to_cart`).
- **Any arrival order.** The join is a *regular* join, not an event-time window. Each side waits in state for the other, so a basket published before its click, or a click that arrives days late, still matches. It uses no watermark, so nothing is dropped as "too late". (The Spark job once lost late events to a watermark; see the git history.) Only sessions use one (below).
- **Through Kafka, not straight into ClickHouse.**
  - The job needs only Flink's own Kafka connector.
  - A ClickHouse outage doesn't stop the job: Kafka buffers the serving topics until ClickHouse reads them again. They keep 48 hours, which bounds what they cost (a second copy of each event); a longer outage is recovered by resetting the checkpoint, which replays the analytics topics (7 days).
  - Flink SQL can't write to ClickHouse with an official connector: ClickHouse's own Flink sink supports only the Java DataStream API so far. Once it supports Flink SQL, a sink file in `connectors/` can replace this hop.
  - The serving topics can feed other stores later, such as a lakehouse table, without touching the job.

## Attribution rules

Clients send no attribution: an `add_to_cart` is matched with every `click` that:

1. is of the same tenant, by the same `user_id` (a person keeps their UUID when they register, so a click made as a visitor matches a basket addition after signing in);
2. was for the same product (a click without a product is never credited);
3. came at most **7 days** before the basket addition (`event_time`, the user's own time), and not after it.

Flink writes each match (one row per basket addition and candidate click). **The latest click wins** (last click): ClickHouse credits the one with the largest `(click_time, click_event_id)` per basket addition. Flink can't pick it itself and still write an append-only stream: a click that arrives late would have to retract a match already written, which needs an upsert sink. ClickHouse then counts each click once per product (`uniqExact(click_event_id, product_id)`), under the basket addition's client type (`client_type`). When a basket addition's candidates are stored in different batches (the user clicked the product in two campaigns), today's count credits both until the nightly check corrects the closed day (`backend/README.md`, "Daily totals").

**The same rules in the history backfill.** `airflow/jobs/backfill/spark_backfill.py` recomputes older days from the archive with the same rules, so a rule change here must change it too. `airflow/tests/fixtures/attribution_cases.json` runs the same cases through both (`pnpm test:flink`, `pnpm test:backfill`).

**Why 7 days.** Retail media networks credit purchases days after a click (Amazon Ads and Walmart Connect use 14-day windows); 24 hours missed shoppers who come back later. The window is one constant in [`02_attributed_baskets.sql`](sql/pipelines/02_attributed_baskets.sql); a per-tenant window would keep candidates for the longest one and filter per tenant in ClickHouse.

**State size.** Each side is kept for **12 days after it arrives** (`STATE_TTL`): analytics-service accepts events up to 5 days old (`MAX_EVENT_AGE_MS`), and the window adds 7. So a pair that can match is always both in state. At most 12 days of clicks and basket additions are held, in RocksDB on the checkpoint volume (incremental checkpoints copy only what changed). The analytics topics keep 14 days, so a replay can rebuild all of it.

## Sessions

[`03_sessions.sql`](sql/pipelines/03_sessions.sql): a user's events (per tenant) with no gap of **6 hours** or more between them form one session, an event-time `SESSION` window partitioned by `(tenant_id, user_id)`. Each session is one row in `analytics.sessions`: start, last event, counts per event type, web/mobile, the campaigns it saw or clicked, its clicks' `campaign:product` pairs and the products it added to the cart. ClickHouse counts, per campaign seen, the sessions, the converted ones (it added a product it clicked in that campaign) and their average duration (`/ad/:id/sessions`).

- **Event time and the watermark.** A session window needs to know when no more events of a session can come. The source's watermark trails the newest event time by **1 hour** (`analytics_events.source.sql`), and a topic partition with no new events stops holding it back after a minute (`table.exec.source.idle-timeout`).
- **Late events are left out of sessions** (only): an event more than an hour behind the watermark (a phone that was offline) is dropped from sessions, but still stored and counted everywhere else. Flink's `numLateRecordsDropped` metric shows how many.
- **Lag.** A session is written once, when the watermark passes its last event + 6 hours: about 7 hours after it. Session numbers run that far behind the other metrics.
- **Attribution doesn't depend on sessions.** The 7-day window spans sessions on purpose, so a shopper who comes back the next day is credited; sessions add the same-session conversion next to it.
- **Duplicates.** At least once, like the rest: a session written again after a restart has the same `(tenant, user, start)`, so the same `session_id`, and is merged away and counted once.
- The aggregation is in the pipeline's `INSERT`, not a view: Flink fails to expand a view holding a partitioned session window.
- **Checking it.** `test:flink` can't close a session on a running stack (the shared watermark makes past-dated test events late, and future-dated ones would make real events late), so check the written sessions against raw events instead. Every session should show the same counts as its user's raw events in its span, and no raw event within 6 hours of either edge:

  ```sql
  SELECT count() AS sessions,
         countIf(events = raw_events) AS counts_match,
         countIf(neighbours = 0) AS boundaries_match
  FROM
  (
      SELECT s.session_id, any(s.events) AS events,
             countIf(e.event_time BETWEEN s.session_start AND s.last_event_time) AS raw_events,
             countIf((e.event_time < s.session_start AND e.event_time > s.session_start - INTERVAL 6 HOUR)
                  OR (e.event_time > s.last_event_time AND e.event_time < s.last_event_time + INTERVAL 6 HOUR)) AS neighbours
      FROM analytics.sessions AS s FINAL
      INNER JOIN (SELECT tenant_id, assumeNotNull(user_id) AS user_id, event_time FROM analytics.events FINAL WHERE user_id IS NOT NULL) AS e
          ON s.tenant_id = e.tenant_id AND s.user_id = e.user_id
      GROUP BY s.session_id
  )
  ```

  An event that arrived late for its session makes `raw_events` larger for that one session.

## Delivery and duplicates

- **Checkpoints every 60 s** hold the Kafka offsets and the join state (RocksDB, incremental). They are kept when the job stops (`RETAIN_ON_CANCELLATION`). Rows are written as they are processed, so the interval doesn't delay them; it only bounds how much is read again after a restart.
- **After a crash**, Flink retries the failed tasks from the last checkpoint (`restart-strategy` in [`config.yaml`](config.yaml)).
- **After a container restart**, [`run.sh`](run.sh) resumes from the newest complete checkpoint in `CHECKPOINT_DIR`, in `CLAIM` mode, so the new job owns it and deletes it once a newer one exists.
- **At least once:** what was written after the last checkpoint is written again after a restart. ClickHouse absorbs this:
  - both raw tables are `ReplacingMergeTree`, keyed down to the event IDs, so copies are merged away;
  - the daily totals count a copy that arrives in a later batch until the nightly check recounts that day from raw events, so past days are exact and today's total can be a little high (`backend/README.md`, "Daily totals").
- **Malformed records** (invalid JSON, or a missing or non-UUID `eventId`, `tenantId` or `timestamp`) are dropped. An optional ID that isn't a UUID becomes `NULL`. analytics-service already validates events, so this only guards the sink.

## Run it

`../docker-compose.yml` runs it as `flink-streaming`. The Flink web UI (job graph, checkpoints, backpressure) is at http://localhost:8081.

```bash
docker compose up -d --build flink-streaming
docker compose logs -f flink-streaming        # "Job ID: …", then "Restoring from …" after a restart
docker compose exec clickhouse clickhouse-client --user basketline --password basketline_dev \
  --query "SELECT count() FROM analytics.attributed_baskets"
```

**Test:** `pnpm test:flink` (from `backend/`, with the stack up) publishes clicks and baskets to the real topics. It then checks in ClickHouse that exactly the baskets the rules allow were credited, including one whose click is published after it.

## Resetting the checkpoint

Flink can't restore a checkpoint after the job's SQL changes the shape of its state, for example a new join or different columns in the join. The container then keeps failing with a state restore error. Start fresh:

```bash
docker compose stop flink-streaming
docker compose run --rm --no-deps --entrypoint sh flink-streaming -c 'rm -rf /checkpoints/*'
docker compose up -d flink-streaming
```

The job then reads Kafka from `KAFKA_STARTUP_MODE` (`earliest-offset`), which is everything Kafka keeps (14 days of analytics events). The replayed events are merged away as duplicates, their basket additions are matched again, and their sessions rebuilt (the same session IDs). To skip the replay, set `KAFKA_STARTUP_MODE=group-offsets` for that start. It resumes from the offsets Flink commits to Kafka at each checkpoint, but clicks still in the old state are lost, so their later baskets aren't credited.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Brokers (`kafka:19092` inside compose) |
| `KAFKA_TOPIC_PREFIX` | empty | Must match analytics-service's `KAFKA_TOPIC_PREFIX`. `kafka.sql` reads unprefixed topics |
| `KAFKA_GROUP_ID` | `events-to-clickhouse` | The consumer group Flink commits offsets to at each checkpoint (for lag monitoring) |
| `KAFKA_STARTUP_MODE` | `earliest-offset` | Used only when there is no checkpoint: `earliest-offset`, `latest-offset` or `group-offsets` |
| `CHECKPOINT_DIR` | `/checkpoints` | Keep it on a persistent volume; never share it between jobs |

Memory, task slots and parallelism are set in [`config.yaml`](config.yaml): a 768 MB job manager, and a 1280 MB task manager with 2 slots and a parallelism of 2.
