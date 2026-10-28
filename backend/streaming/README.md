# streaming: Kafka → PySpark Structured Streaming → ClickHouse

Reads every analytics topic that analytics-service publishes to (`analytics.<eventName>.v1`) and writes **one row per event** into ClickHouse `analytics.events`. The `/ad` metrics are counted from that table.

## Architecture

Kafka topics (`subscribePattern ^analytics\..+\.v1$`) → parse and validate the envelope → drop events already seen in the last hour → `foreachBatch`: group the batch **tenant-wise, then event-wise** → drop duplicates within each partition → `clickhouse-connect` inserts per partition → `analytics.events`.

**Why tenant, then event.** `analytics.events` is sorted by `(tenant_id, event_name, campaign_id, event_time, event_id)`, because every query filters on a tenant and an event. Each micro-batch is shaped to match:

1. `prepare_batch` hash-partitions by `(tenant_id, event_name)` into `SPARK_SHUFFLE_PARTITIONS` partitions (4 by default), then sorts each partition in the table's order.
   - Each ClickHouse insert therefore covers a few whole tenant/event slices, already sorted.
   - That means fewer, larger parts and less background merging, compared with one small unsorted insert per Kafka partition (36 per batch before this change).
2. Copies of one event share `tenant_id` and `event_name`, so they land in the same partition. `unique_events` drops them there, with no second shuffle by `event_id`.
3. A ClickHouse client is opened only for partitions that have rows, so empty batches cost nothing.

If one tenant ever dominates the traffic, its slices still spread across partitions by event name. Partitioning by `(tenant_id, event_name, campaign_id)` would spread it further.

```
src/event_pipeline/
  config.py           settings from env / .env (pydantic-settings)
  schemas.py          the envelope schema, and the ClickHouse column order
  transformations.py  parse_events(): Kafka rows → event rows; prepare_batch(): tenant/event grouping
  sinks.py            write_batch(), unique_events(): partition-level inserts with clickhouse-connect
  job.py              the streaming query (Kafka source, trigger, checkpoint)
  main.py             entry point for spark-submit
tests/unit/           transformation and row-conversion tests (Spark local mode)
```

The table schema is in `../infra/clickhouse/init.sql`. An existing volume is upgraded with `../infra/clickhouse/migrations/004_uuid_tenants.sql`; the steps are in that file. It is shared with analytics-service's tests, which create a temporary database from it.

## Delivery and duplicates

- **Offsets live only in the checkpoint** (`CHECKPOINT_LOCATION`); nothing is committed to Kafka, and auto-commit is never on (Spark's Kafka source disables it).
  - **Each batch:** Spark writes the batch's Kafka offsets to the checkpoint, runs `write_batch`, and only then marks the batch done.
  - **After a crash:** the job resumes from the checkpoint and re-runs the unfinished batch (at least once).
  - **If the checkpoint is lost:** the job starts again from `KAFKA_STARTING_OFFSETS` (earliest). That is a full replay, and it is safe because of the deduplication below.
  - `KAFKA_GROUP_ID` only names Spark's consumers (`groupIdPrefix`), for broker logs and ACLs. They don't commit, so the group shows no lag. Follow progress in the Spark query progress (input rate, batch duration, end offsets).
- **Duplicates are kept out, and harmless if they get in:**
  1. **Replayed batches** after a crash are rebuilt from the same offsets, in the same order (`prepare_batch` sorts down to `event_id`), so their inserts are identical. ClickHouse skips an identical insert (`non_replicated_deduplication_window`).
  2. **Within a batch**, copies meet in one partition and `unique_events` drops them.
  3. **Re-sent events across batches** (the same `eventId` posted again, or a producer retry) are stored, then merged by `ReplacingMergeTree`; every count (`/ad` and the daily job) uses `uniqExact(event_id)`, so they count once even before that.
  - The query keeps no state. It used to drop re-sent events with a 1-hour watermark, but a watermark also drops *late* rows: while catching up on a backlog (a replay, or a restart after more than an hour), one topic running ahead moved it past events still unread on other topics, and those were lost without an error.
- **Malformed records are dropped:** invalid JSON, or a missing or non-UUID `eventId`, `eventName` or `timestamp`. An optional ID that isn't a UUID becomes `NULL`. analytics-service already validates events, so this only guards the sink.

## Upgrading: resetting the checkpoint without a full replay

Spark can't resume a checkpoint after a stateful step is added to or removed from the query (`drop_redelivered` was added, then removed). It fails, for example, with `CANNOT_LOAD_STATE_STORE ... delta file not exists`. Start a new checkpoint at the exact offsets where the old one stopped:

```bash
docker compose stop spark-streaming
# End offsets of the last committed batch (offsets/<n> for the newest commits/<n>).
OFFSETS=$(docker compose run --rm --no-deps --entrypoint sh spark-streaming -c \
  'cd /checkpoints/events-to-clickhouse && tail -1 offsets/$(ls commits | sort -n | tail -1)' | tail -1)
docker compose run --rm --no-deps --entrypoint sh spark-streaming -c 'rm -rf /checkpoints/events-to-clickhouse'
KAFKA_STARTING_OFFSETS="$OFFSETS" docker compose up -d spark-streaming
```

`KAFKA_STARTING_OFFSETS` is read only when there is no checkpoint, so later restarts without it resume normally.

## Run with Docker (normal path)

`../docker-compose.yml` runs it as `spark-streaming`, using this directory's `Dockerfile` (`runtime` target).
- The image is `apache/spark:4.0.4-python3` (Python 3.10, Spark's own pyspark), plus the Kafka connector jars fetched at build time, plus this package installed with `pip`.

```bash
docker compose up -d --build spark-streaming
docker compose logs -f spark-streaming          # "Processed batch_id=…"
docker compose exec clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev \
  --query "SELECT event_name, uniqExact(event_id) FROM analytics.events GROUP BY event_name"
```

## Tests and linting

The tests need Spark and Java, so they run inside the image:

```bash
docker build --target test .        # runs pytest; the build fails if a test fails
uvx ruff check . && uvx ruff format --check .
```

To run them locally instead (Java 17 required): `uv sync && uv run pytest`.

## Run locally (outside Docker)

Requires Java 17 and `uv`, with Kafka and ClickHouse from `../docker-compose.yml` running.

```bash
cp .env.example .env
uv sync
uv run spark-submit \
  --packages org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.4 \
  --conf spark.sql.session.timeZone=UTC \
  --master 'local[*]' \
  src/event_pipeline/main.py
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Brokers (`kafka:19092` inside compose) |
| `KAFKA_TOPIC_PREFIX` | empty | Must match analytics-service's `KAFKA_TOPIC_PREFIX` |
| `KAFKA_GROUP_ID` | `events-to-clickhouse` | Prefix of Spark's consumer group ids (naming only, no commits) |
| `KAFKA_STARTING_OFFSETS` | `earliest` | Used only when there is no checkpoint yet |
| `KAFKA_MAX_OFFSETS_PER_TRIGGER` | `200000` | Upper bound per micro-batch |
| `SPARK_TRIGGER_INTERVAL` | `30 seconds` | Micro-batch interval, which is also how stale the dashboard can be |
| `SPARK_SHUFFLE_PARTITIONS` | `4` | Partitions of the `(tenant_id, event_name)` shuffle, i.e. insert streams per batch. Raise it with more cores or traffic |
| `CHECKPOINT_LOCATION` | `./var/checkpoints/events-to-clickhouse` | Keep it stable across restarts; never share it between queries |
| `CLICKHOUSE_HOST` / `CLICKHOUSE_PORT` / `CLICKHOUSE_SECURE` | `localhost` / `8123` / `false` | ClickHouse HTTP interface |
| `CLICKHOUSE_USERNAME` / `CLICKHOUSE_PASSWORD` | `default` / empty | compose uses `ecommerce_analytics` / `ecommerce_analytics_dev` |
| `CLICKHOUSE_DATABASE` / `CLICKHOUSE_TABLE` | `analytics` / `events` | |
| `CLICKHOUSE_INSERT_BATCH_SIZE` | `5000` | Rows per insert, which bounds memory per Spark partition |

## Reload ClickHouse from Kafka

Delete the checkpoint and restart. The job starts again from the earliest offsets, and the replay is absorbed as described above. Kafka keeps events for its retention period, 7 days by default.

```bash
docker compose stop spark-streaming && docker compose rm -f spark-streaming
docker volume rm ecommerce-analytics_spark-checkpoints
docker compose up -d spark-streaming
```

## Before production

- **Checkpoints:** store them on durable shared storage (for example S3), not a Docker volume.
- **Malformed records:** add a dead-letter topic or table for them, instead of dropping them.
- **Observability:** add metrics and alerts for Spark query progress, consumer lag, batch duration and insert latency.
- **Security:** Kafka TLS/SASL, ClickHouse credentials from a secret manager, and least-privilege users.
- **Capacity:** size the Kafka partitions (3 per topic today), Spark resources (`local[2]` today) and insert batch size from load tests.
