# airflow: batch jobs: the Iceberg archive of raw events, and history backfills

ClickHouse keeps raw events and credited basket additions for 14 days; the `/ad` daily totals keep every day. Airflow copies each raw day to an **Iceberg archive on S3**, which keeps them forever at object-storage prices and can be queried with Athena (or Spark, Trino, Snowflake, DuckDB) without touching ClickHouse.

```
ClickHouse events, attributed_baskets ──(nightly, day D-6)──► jobs/export_archive.py ──► Iceberg archive.events, archive.attributed_baskets
  (14 days)                                                     PyIceberg                  S3 + Glue catalog (forever)
```

| | Locally (`docker-compose.yml`) | On AWS |
|---|---|---|
| Object storage | `archive-storage` (SeaweedFS, S3 API on :8333, UI on http://localhost:23646) | S3 bucket `ad-insights-archive` |
| Iceberg catalog | PyIceberg SQL catalog in Postgres (`iceberg_catalog_db`) | AWS Glue (database `archive`) |
| Scheduler | `airflow` (standalone), UI on http://localhost:8082 | official Airflow Helm chart, KubernetesExecutor (`deploy/helm/environments/local/airflow.yaml`) |
| Maintenance | — | Athena `OPTIMIZE` / `VACUUM` (`archive_maintenance` DAG) |

## Layout

```
Dockerfile             apache/airflow + the jobs' own virtualenv (/opt/jobs), so their pins never meet Airflow's
requirements.txt       the jobs' dependencies (PyIceberg, pyarrow, clickhouse-connect)
dags/                  scheduling only: which job, which day, retries
  archive_export.py      nightly 01:00 UTC: exports day D-6 of each table
  archive_maintenance.py monthly, AWS only: Athena OPTIMIZE + VACUUM
  history_backfill.py    on demand: recompute closed months of the daily tables from the archive
jobs/                  the work, as plain scripts that also run without Airflow
  export_archive.py
  backfill/              spark_backfill.py (Spark) and load_backfill.py (ClickHouse staging and swap)
s3-lifecycle.json      storage classes for the archive bucket on AWS
tests/                 the jobs against the running stack
```

## The nightly export

**Which day.** Each run exports the day six days before its date. analytics-service accepts events up to 5 days late, so by then the day is complete. ClickHouse keeps 14 days, so a failed export can be retried for another week. Airflow retries a failed task 3 times, and runs missed while it was down are caught up when it is back.

**Safe to re-run.** `export_archive.py --table T --day D` deletes day D from the Iceberg table and appends ClickHouse's rows for D **in one commit**. A retry or a backfill replaces the day instead of duplicating it, and a run that fails half-way commits nothing. It reads with `FINAL`, so copies ClickHouse hasn't merged away yet are archived once. It refuses a day ClickHouse no longer keeps, since that would replace the archived day with nothing.

**Columns.** The tables follow ClickHouse's columns. A new one (`client_type`, `user_type`) is added at the end of an existing Iceberg table. A dropped one (`anonymous_id`, before every visitor had a `user_id`) stays, NULL from then on, since dropping it would break reading older files.

**Table layout.** Both tables are partitioned by `day(event_time)` and `bucket(16, tenant_id)`: a query for a date range reads only those days, and a tenant's query reads one bucket of each. IDs are stored as strings (Athena has no UUID type), times as `timestamptz` in UTC, and the files are Parquet with zstd.

**Files.** Each append writes one file per partition, so the job appends in batches of 500,000 rows: a day of up to 500,000 rows gets one file per partition, and a bigger day one per partition per batch, which the monthly `OPTIMIZE` merges.

## Run it

```bash
docker compose up -d --build archive-storage airflow
open http://localhost:8082                     # DAGs → archive_export; no login (local only)
```

Export a day by hand, or re-export one (safe at any time):

```bash
docker compose exec airflow airflow backfill create --dag-id archive_export --from-date 2026-10-30 --to-date 2026-10-31 --reprocess-behavior completed
docker compose exec airflow /opt/jobs/bin/python /opt/airflow/jobs/export_archive.py --table events --day 2026-10-24
```

A backfill covers the runs scheduled between the two dates (the 01:00 run of 10-30 here), and each run exports the day six days before it (10-24). Query the archive from Python:

```bash
docker compose exec airflow /opt/jobs/bin/python -c "
from pyiceberg.catalog import load_catalog
print(load_catalog('archive').load_table('archive.events').scan().to_arrow().group_by('event_name').aggregate([('event_id', 'count')]))"
```

**Test:** `npm run test:airflow` (from `backend/`, with ClickHouse, Postgres and `archive-storage` up; needs [uv](https://docs.astral.sh/uv/)). It exports a day twice, including an event delivered twice, and checks that the archive holds each row once. It also checks that a day ClickHouse no longer keeps is refused. It writes to the `archive_test` namespace.

## Backfilling history

ClickHouse's daily tables keep every day, but the nightly check can only correct the 14 days whose raw events ClickHouse still holds. To correct older days, for example after a bug fix or a change to the attribution or session rules, the `history_backfill` DAG recomputes them from the archive's raw events, with the current rules. It can cover one tenant, several or all, and any number of months.

```
validate → spark_backfill (local or EMR Serverless) → prepare → check → swap (only with apply=true)
```

| Step | Engine | What it does |
|---|---|---|
| `spark_backfill` ([`jobs/backfill/spark_backfill.py`](jobs/backfill/spark_backfill.py)) | Spark | Reads raw events for `[from − 7 days, to + 1 day)` and the tenants in scope. Credits each `add_to_cart` to the same user's latest click on the product in the 7 days before it, and splits sessions at a 6-hour gap. Writes small exact rows to Iceberg (`backfill.event_totals`, `customer_days`, `sessions`, partitioned by run). |
| `prepare` ([`jobs/backfill/load_backfill.py`](jobs/backfill/load_backfill.py)) | ClickHouse | For every touched month of the three daily tables, builds `<table>_rebuild`: the month's live rows outside the scope as they are, plus the recomputed rows. It reads Spark's rows with `icebergS3` and builds the customer and session sketches with the live views' own functions, so they merge with live rows. It backs up the live month into `<table>_before_rebuild` and logs a before/after report per tenant and day. |
| `check` | ClickHouse | Rows outside the scope are equal in staging and live, and every month is backed up. |
| `swap` | ClickHouse | `ALTER TABLE … REPLACE PARTITION <month> FROM <table>_rebuild` for every table and month, back to back. If one fails, the months already swapped go back from the backup. |

- **Nothing live changes before `swap`.** Without `apply`, the run is a dry run: read `prepare`'s log.
- **Dashboards never see an empty or partial month.** Nothing is deleted from a live table. Each `REPLACE PARTITION` swaps a month's parts atomically, so a query sees the whole old month or the whole new one. The whole swap is metadata operations and takes seconds, whatever the backfill's size. For those seconds, one month can be corrected while the next isn't yet.
- **Only closed months.** The daily tables are partitioned by month (rows stay one per day). A month can be backfilled once its last day is more than 6 days ago: events arrive at most 5 days late, and the archive holds a day from 6 days after it. No live view or nightly check writes to such a month, so a swap can't race them.
- **Why Spark and ClickHouse.** Spark does the heavy part (the 7-day join and sessions over months of raw events) away from the cluster that serves dashboards. ClickHouse builds the sketches, because they must be byte-compatible with the live rows. Its part reads only Spark's reduced rows, under its own limits (`BACKFILL_MAX_THREADS`, `BACKFILL_MAX_MEMORY_BYTES`).
- **The same rules as Flink.** A rule change must change [`02_attributed_baskets.sql`](../flink/sql/pipelines/02_attributed_baskets.sql) and `spark_backfill.py` together. [`tests/fixtures/attribution_cases.json`](tests/fixtures/attribution_cases.json) runs the same cases through both (`npm run test:flink`, `npm run test:backfill`).
- **Context.** Basket additions in the first week need clicks from the week before `from`. The run refuses if the archive starts later, unless `allow_partial_context` is set. A session longer than 7 days that starts before the range is seen only from that point.

Run it (a dry run, then apply):

```bash
docker compose exec airflow airflow dags trigger history_backfill --conf '{"from": "2026-08-01", "to": "2026-09-01", "tenants": "all", "apply": false}'
docker compose exec airflow airflow dags trigger history_backfill --conf '{"from": "2026-08-01", "to": "2026-09-01", "tenants": "5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01", "apply": true}'
# Undo a swapped run (its months come back from the backup, until a later run prepares the same months):
docker compose exec airflow /opt/jobs/bin/python /opt/airflow/jobs/backfill/load_backfill.py rollback --run-id <run id>
```

Each run is recorded in ClickHouse's `backfill_runs` (range, tenants, months, status). After a successful swap, its rows in the `backfill` Iceberg tables are deleted.

**On EMR Serverless.**
1. Create an EMR Serverless Spark application (an EMR release with Spark and Iceberg).
2. Give its execution role:
   - Glue access to the `archive` and `backfill` databases;
   - S3 read on the archive;
   - S3 read/write on `backfill/`.
3. Upload `jobs/backfill/spark_backfill.py` to S3.
4. Set the Airflow variables:
   - `backfill_runtime=emr`;
   - `emr_serverless_application_id`, `emr_serverless_role_arn`;
   - `backfill_script_s3` (the script's S3 URL);
   - `archive_warehouse` (`s3://<bucket>`).
5. Point `ARCHIVE_S3_URL` at the bucket's HTTPS URL, and give ClickHouse read access to `backfill/` (its IAM role, or keys).

It costs nothing between runs and scales up for a large backfill. Only the local path is tested here; the EMR task is checked by the DAG loading.

**Test:** `npm run test:backfill` (from `backend/`). It runs in the Airflow container, which has Java, so the stack must be up with a rebuilt `airflow` image. It writes the shared attribution cases, a session and two tenants' events for July–August 2026 into `archive_test`, then:
- backfills one tenant for half of August while a reader checks the month is never empty or partial;
- checks the corrected and untouched days, the other tenant, the attribution winners, the sketches and the sessions;
- rolls back;
- backfills all tenants for two months, with a forced failure during the swap that's undone;
- swaps again.

## On AWS

- **Catalog:** set `PYICEBERG_CATALOG__ARCHIVE__TYPE=glue` and `PYICEBERG_CATALOG__ARCHIVE__WAREHOUSE=s3://<bucket>`, and drop the `URI`, `S3__ENDPOINT` and key variables. The job creates the Glue database `archive` and both tables on its first run.
- **Credentials:** give the Airflow service account an IAM role (IRSA or EKS Pod Identity) instead of keys. It needs S3 read/write on the bucket, Glue on the `archive` database, and Athena for the maintenance DAG.
- **Maintenance:** set `aws_default` and the Airflow variable `athena_workgroup` (a workgroup with a query result location), then unpause `archive_maintenance`. On the 1st of each month it runs `OPTIMIZE … REWRITE DATA USING BIN_PACK` for the last 40 days, then `VACUUM`, which expires old snapshots and deletes unreferenced files (Athena's defaults keep 5 days of snapshots).
- **Storage classes:** apply [`s3-lifecycle.json`](s3-lifecycle.json):

  ```bash
  aws s3api put-bucket-lifecycle-configuration --bucket ad-insights-archive --lifecycle-configuration file://s3-lifecycle.json
  ```

  Data files move to Standard-IA after 30 days and to Glacier Instant Retrieval after 180, and stay readable in milliseconds, so Athena queries keep working. Metadata files stay in Standard, because every query reads them. Unfinished multipart uploads are deleted after 7 days.

## Configuration

| Variable | Purpose |
|---|---|
| `CLICKHOUSE_URL` | ClickHouse to read the raw tables from (as for analytics-service) |
| `PYICEBERG_CATALOG__ARCHIVE__*` | The Iceberg catalog: `TYPE` (`sql` or `glue`), `URI`, `WAREHOUSE`, `S3__ENDPOINT`, `S3__REGION`, `S3__ACCESS_KEY_ID`, `S3__SECRET_ACCESS_KEY` ([PyIceberg configuration](https://py.iceberg.apache.org/configuration/)) |
| `ARCHIVE_NAMESPACE` | The Iceberg namespace (Glue database). Default `archive`; the test uses `archive_test` |
