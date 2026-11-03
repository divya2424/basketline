# Basketline: Airflow jobs (history backfills, backups, lake purges)

ClickHouse keeps only the daily tables `/ad` reads (and 3 days of Flink's output they are counted from). Every event ever sent is in the **data lake**: Kafka Connect writes every topic to Iceberg tables on S3 ([`../connect/`](../connect/)). Airflow runs the batch jobs around them:

| DAG | When | Job | What |
|---|---|---|---|
| `history_backfill` | on demand | [`jobs/backfill_daily.py`](jobs/backfill_daily.py) | Recomputes past days of ClickHouse's daily tables from the lake, and swaps them in |
| `clickhouse_backup` | daily 02:30 UTC | [`jobs/backup_clickhouse.py`](jobs/backup_clickhouse.py) | Backs up the daily tables and the erasure and backfill records to S3 |
| `tenant_purge` | daily 02:00 UTC | [`jobs/purge_tenants.py`](jobs/purge_tenants.py) | Deletes deleted tenants' and erased shoppers' rows from the lake |
| — | on demand | [`jobs/import_history.py`](jobs/import_history.py) | Imports a tenant's past interactions (older than the API takes) into the lake, for a history backfill |

| | Locally (`docker-compose.yml`) | On AWS |
|---|---|---|
| Object storage | `archive-storage` (SeaweedFS, S3 API on :8333, UI on http://localhost:23646): the lake in `basketline-pipeline/lake/`, backups in `ad-insights-archive/clickhouse-backups/` | S3 buckets |
| The lake's catalog | Iceberg JDBC/SQL catalog in Postgres (`iceberg_catalog_db`), shared with Kafka Connect | AWS Glue |
| Scheduler | `airflow` (standalone), UI on http://localhost:8082 | official Airflow Helm chart, KubernetesExecutor (`deploy/helm/environments/local/airflow.yaml`) |

## Layout

```
Dockerfile             apache/airflow + the jobs' own virtualenv (/opt/jobs), so their pins never meet Airflow's;
                       built from basketline/, with ClickHouse's schema files (the backfill builds its scratch database from them)
requirements.txt       the jobs' dependencies (PyIceberg, pyarrow, clickhouse-connect)
dags/                  scheduling only: which job, when, retries
jobs/                  the work, as plain scripts that also run without Airflow
tests/                 the jobs against the running stack
```

## History backfill

To fix past days (a counting bug fixed, a tenant's events that were wrong) or to fill a new daily table's past, the job recomputes whole UTC days from the lake with the current rules:

```bash
docker compose exec airflow /opt/jobs/bin/python /opt/airflow/jobs/backfill_daily.py --from 2026-11-01 --to 2026-11-05 \
  [--tenant <uuid> ...] [--table <daily table> ...]
docker compose exec airflow /opt/jobs/bin/python /opt/airflow/jobs/backfill_daily.py --rollback   # undo the latest run
```

Or trigger `history_backfill` in the UI, with `from_day`, `to_day`, `tenants`, `tables` or `rollback`.

1. **A scratch database from the real schema.** `analytics_backfill` is created from `infra/clickhouse/01_tables.sql` and `02_materialized_views.sql` (`analytics` renamed, the hourly check left out), so the recomputed rows come from the same materialized views as live ones, every daily table included, and a new one with no extra code.
2. **The lake into its staging tables, a day at a time.** ClickHouse reads the lake's interactions table with `icebergS3` (only the hourly partitions the day's events can be in) and inserts what the Flink job would have written:
   - the day's ad impressions and clicks with a campaign;
   - each of the day's basket additions with every click on its product by the same user in the 7 days before it (the views credit the latest);
   - the sessions that began that day (no gap of 30 minutes; the day before and after tell where they start and end).

   Each event once (`LIMIT 1 BY event_id`); deleted tenants and erased shoppers left out; only the tenants asked for.
3. **An atomic swap per month.** For each month the days fall in, the scratch table gets the live rows of every other day and tenant, the live month moves into `previous_<table>`, and the scratch month replaces it (`REPLACE PARTITION`). Meanwhile ClickHouse stops reading Kafka (the queue views are detached) and the hourly check waits, so no live row is lost: reading resumes from the committed offsets after.
4. **Kept until the next run.** The scratch database, with the months as they were, stays until the next run, to look into or to `--rollback` (once). Each run is recorded in `analytics.backfill_runs`.

**Which days.** Only settled days, 3 days old or more: ingestion accepts events up to 2 days late, so no live event can change them during the swap. And only days the lake holds whole: from the first full day after it began (Kafka Connect started from the topics' oldest messages). The job refuses anything else.

**The same rules as Flink.** A rule change in [`02_attributed_baskets.sql`](../flink/sql/pipelines/02_attributed_baskets.sql) or [`03_sessions.sql`](../flink/sql/pipelines/03_sessions.sql) must change `backfill_daily.py` too. The attribution cases in [`test/fixtures/attribution_cases.json`](../test/fixtures/attribution_cases.json) run through both (`pnpm test:flink`, `pnpm test:airflow`). Sessions differ in one way, on purpose: the backfill has no watermark, so an event that arrived too late for its live session is in its recomputed one.

**A new daily table:** add it and its view to the schema files and a migration; it counts live data from then. Three days later, backfill it with `--table <name>` from the lake's first full day to the day it was created; that day is recomputed whole, so its partial live count is replaced.

**Cost and limits.** The reads are of Parquet files, pruned to the days' hourly partitions; the swap is metadata only. Large ranges run a day at a time; split very long ones into several runs.

## History import

A tenant's events from before it sent them to Basketline (a retailer's past data, or `pnpm seed:demo` in `retailer-sim/`) can't go through the API, which takes events at most 2 days old. `import_history.py` appends them to the lake's interactions table, one JSON object per line as ingestion-service publishes them. Kafka Connect writes rows the same way, and the Kafka time of each row is when its event was received. Then the history backfill computes those days:

```bash
docker compose exec -T airflow /opt/jobs/bin/python /opt/airflow/jobs/import_history.py --tenant <uuid> < events.jsonl
docker compose exec airflow /opt/jobs/bin/python /opt/airflow/jobs/backfill_daily.py --from <day after the first imported> --to <last imported> --tenant <uuid>
```

- **What it refuses:** rows of another tenant, events from the last 2 days (send those through the API), and a second import for the same tenant (exit 3), so its history can't be counted twice.
- **The lake's start moves earlier.** The backfill counts days from the lake's oldest Kafka time, and the import makes that the oldest imported day. Always run that backfill with `--tenant`: an unscoped backfill of those early days would recompute every other tenant from an empty lake.
- **Before Kafka Connect's first commit** (hourly), the table doesn't exist yet. The import then creates it with the columns the backfill reads, partitioned like Connect's, and Connect adds the rest.

## Backups

`clickhouse_backup` runs `BACKUP TABLE …` to `CLICKHOUSE_BACKUP_S3_URL/<day>`: the daily tables (the lake can recompute them, but slowly), `deleted_tenants`, `deleted_users` and `backfill_runs`. A day already backed up is left as it is, so a retry is safe. Restoring: the backend README, "Restoring ClickHouse from a backup".

## Lake purges

Deleting a tenant removes it from ClickHouse at once (ingestion-service); `tenant_purge` deletes its rows from every lake table (`payload_tenantId`), and an erased shopper's from the interactions and identity tables (`payload_userId`). It purges every deleted tenant and shopper on every run, not only new ones: Kafka still holds their messages (14 days, and the compacted topics until compaction), so a replay of the connector could append them again. A run with nothing to delete only reads table metadata. `lake_purged_at` in ClickHouse records the first purge.

To remove one tenant's rows without deleting it (the load test's, after `loadtest/cleanup.sql`):

```bash
docker compose exec airflow /opt/jobs/bin/python /opt/airflow/jobs/purge_tenants.py --tenant <uuid>
```

The lake's tables are partitioned by tenant and hour, so a tenant's deletion drops whole files; a shopper's rewrites only the files that have their rows.

## Test

`pnpm test:airflow` (from `basketline/`, with ClickHouse, Postgres and `archive-storage` up; needs [uv](https://docs.astral.sh/uv/)):

- **Backfill:** a fixture lake table (`lake_test.interactions`, shaped like Kafka Connect's) with the attribution cases, duplicates, events without a store, an erased shopper and a deleted tenant, backfilled into a throwaway database. It checks the counts, the credits per campaign, the customers, the sessions (gap, day boundary, web/mobile, conversion), tenant scope, rollback and the guards.
- **Purge:** deleted tenants and erased shoppers removed from a fixture lake table.

## On AWS

- **Catalog:** set `PYICEBERG_CATALOG__LAKE__TYPE=glue` and the warehouse (`s3://<bucket>`), and drop the URI, endpoint and key variables. Switch Kafka Connect to the same catalog: in `connect/lake-sink.json`, `iceberg.catalog.catalog-impl` becomes `org.apache.iceberg.aws.glue.GlueCatalog` (its jars are in the image), without the JDBC and key settings.
- **Credentials:** an IAM role for Airflow's service account (IRSA or EKS Pod Identity): S3 read/write on the lake, Glue on its database. ClickHouse reads the lake and writes backups with its own IAM role: leave `PYICEBERG_CATALOG__LAKE__S3__ACCESS_KEY_ID` and `BACKUP_S3_*` unset.
- **Storage classes:** an S3 lifecycle rule on the lake's data files (Standard → Infrequent Access after 30 days → Glacier Instant Retrieval after 180), which stay readable in milliseconds; metadata files stay in Standard. Backups expire after 35 days.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `CLICKHOUSE_URL` | all | ClickHouse, as the services' user `basketline` |
| `PYICEBERG_CATALOG__LAKE__*` | purge | The lake's catalog: `TYPE` (`sql` or `glue`), `URI`, `WAREHOUSE`, `S3__ENDPOINT`, `S3__REGION`, `S3__ACCESS_KEY_ID`, `S3__SECRET_ACCESS_KEY` ([PyIceberg configuration](https://py.iceberg.apache.org/configuration/)) |
| `LAKE_NAMESPACE` | purge | The lake's namespace; default `lake` |
| `LAKE_INTERACTIONS_URL` | backfill | The lake's interactions table as ClickHouse reaches it (read with the catalog's S3 keys, or ClickHouse's IAM role) |
| `CLICKHOUSE_SCHEMA_DIR` | backfill | Where the schema files are; default `/opt/airflow/clickhouse` (in the image) |
| `CLICKHOUSE_BACKUP_S3_URL`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | backup | Where backups go, as ClickHouse reaches it |
