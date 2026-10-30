"""Copies one UTC day of a raw ClickHouse table to its Iceberg table in the archive.

    python export_archive.py --table events --day 2026-10-24

Running it again for the same day replaces that day: the day's old rows are
deleted and the new ones appended in one Iceberg commit, so a retry or a
backfill never duplicates rows, and a failed run leaves the day as it was.

The catalog is PyIceberg's `archive` catalog, configured from the environment
(PYICEBERG_CATALOG__ARCHIVE__*): Glue on AWS, a SQL catalog locally.
"""

import argparse
import datetime as dt
import os

import clickhouse_connect
import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.expressions import And, GreaterThanOrEqual, LessThan
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import BucketTransform, DayTransform
from pyiceberg.types import BooleanType, ListType, LongType, NestedField, StringType, TimestamptzType

# ClickHouse keeps raw rows this many days (TTL in infra/clickhouse/01_tables.sql).
# An older day is already gone there, so exporting it would empty it here.
RAW_RETENTION_DAYS = 20
# Rows per append. Each append writes one file per partition, so bigger appends
# mean fewer, larger files.
APPEND_ROWS = 500_000

# Per table: (column, Iceberg type, required, ClickHouse expression). IDs are
# strings: Arrow export and Athena don't support UUID. A new column goes last and
# is optional: existing tables get it added at the end (iceberg_table), and
# Iceberg can't add a required column to rows already written. A column dropped
# in ClickHouse stays here (dropping one from Iceberg breaks older files' reads)
# and is NULL from then on.
_ID = StringType()
_TIME = TimestamptzType()
TABLES = {
    "events": [
        ("event_id", _ID, True, "toString(event_id)"),
        ("event_name", StringType(), True, "toString(event_name)"),
        ("campaign_id", _ID, False, "toString(campaign_id)"),
        ("product_id", _ID, False, "toString(product_id)"),
        ("user_id", _ID, False, "toString(user_id)"),
        ("tenant_id", _ID, True, "toString(tenant_id)"),
        ("page_name", StringType(), False, "page_name"),
        ("feature_name", StringType(), False, "feature_name"),
        # Dropped: the platform credits basket additions to clicks itself (Flink).
        ("attribution_id", _ID, False, "CAST(NULL AS Nullable(String))"),
        ("properties", StringType(), True, "properties"),
        ("event_time", _TIME, True, "event_time"),
        ("received_at", _TIME, True, "received_at"),
        ("ingested_at", _TIME, True, "ingested_at"),
        # Dropped: visitors now have a user_id (with user_type visitor).
        ("anonymous_id", _ID, False, "CAST(NULL AS Nullable(String))"),
        ("client_type", StringType(), False, "toString(client_type)"),
        ("user_type", StringType(), False, "toString(user_type)"),
    ],
    "attributed_baskets": [
        ("basket_event_id", _ID, True, "toString(basket_event_id)"),
        ("click_event_id", _ID, True, "toString(click_event_id)"),
        ("tenant_id", _ID, True, "toString(tenant_id)"),
        ("campaign_id", _ID, True, "toString(campaign_id)"),
        ("product_id", _ID, False, "toString(product_id)"),
        ("user_id", _ID, False, "toString(user_id)"),
        ("event_time", _TIME, True, "event_time"),
        ("click_time", _TIME, True, "click_time"),
        ("ingested_at", _TIME, True, "ingested_at"),
        ("client_type", StringType(), False, "toString(client_type)"),
        ("user_type", StringType(), False, "toString(user_type)"),
    ],
    "sessions": [
        ("session_id", _ID, True, "toString(session_id)"),
        ("tenant_id", _ID, True, "toString(tenant_id)"),
        ("user_id", _ID, True, "toString(user_id)"),
        ("user_type", StringType(), True, "toString(user_type)"),
        ("session_start", _TIME, True, "session_start"),
        ("last_event_time", _TIME, True, "last_event_time"),
        ("events", LongType(), True, "events"),
        ("impressions", LongType(), True, "impressions"),
        ("clicks", LongType(), True, "clicks"),
        ("add_to_carts", LongType(), True, "add_to_carts"),
        ("web", BooleanType(), True, "web"),
        ("mobile", BooleanType(), True, "mobile"),
        # Element IDs of the lists, distinct from the columns' IDs.
        ("campaigns", ListType(101, _ID, element_required=True), True, "arrayMap(c -> toString(c), campaigns)"),
        ("clicked", ListType(102, StringType(), element_required=True), True, "clicked"),
        ("added", ListType(103, _ID, element_required=True), True, "arrayMap(p -> toString(p), added)"),
        ("ingested_at", _TIME, True, "ingested_at"),
    ],
}
# The time column each table's day is of: a basket addition's or event's time, a session's start.
DAY_COLUMN = {"events": "event_time", "attributed_baskets": "event_time", "sessions": "session_start"}


def iceberg_table(catalog, namespace: str, name: str):
    columns = TABLES[name]
    schema = Schema(*(NestedField(i, column, kind, required=required) for i, (column, kind, required, _) in enumerate(columns, 1)))
    field_id = {column: i for i, (column, *_) in enumerate(columns, 1)}
    # A query for one day and tenant reads one of 16 file groups of that day.
    spec = PartitionSpec(
        PartitionField(field_id[DAY_COLUMN[name]], 1000, DayTransform(), "event_day"),
        PartitionField(field_id["tenant_id"], 1001, BucketTransform(16), "tenant_bucket"),
    )
    catalog.create_namespace_if_not_exists(namespace)
    # The same path in every catalog (Glue's default adds ".db"), for s3-lifecycle.json.
    location = f"{catalog.properties['warehouse'].rstrip('/')}/{namespace}/{name}"
    table = catalog.create_table_if_not_exists(f"{namespace}.{name}", schema, partition_spec=spec, location=location)
    # Adds the columns a table created before them lacks.
    with table.update_schema() as update:
        update.union_by_name(schema)
    return table


def export(name: str, day: dt.date) -> int:
    today = dt.datetime.now(dt.UTC).date()
    if day < today - dt.timedelta(days=RAW_RETENTION_DAYS - 1):
        raise SystemExit(f"{day} is past ClickHouse's {RAW_RETENTION_DAYS}-day retention; exporting it would empty the archived day")

    table = iceberg_table(load_catalog("archive"), os.environ.get("ARCHIVE_NAMESPACE", "archive"), name)
    target = table.schema().as_arrow()
    start = dt.datetime.combine(day, dt.time(), dt.UTC)
    time = DAY_COLUMN[name]
    this_day = And(GreaterThanOrEqual(time, start.isoformat()), LessThan(time, (start + dt.timedelta(days=1)).isoformat()))
    # FINAL: one row per key, without the copies ClickHouse hasn't merged away yet.
    query = f"SELECT {', '.join(f'{expr} AS {column}' for column, _, _, expr in TABLES[name])} FROM {name} FINAL WHERE toDate({time}) = {{day:Date}}"

    clickhouse = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"])
    rows, pending = 0, []
    with table.transaction() as tx:
        tx.delete(this_day)
        with clickhouse.query_arrow_stream(query, parameters={"day": day}) as batches:
            for batch in batches:
                pending.append(batch.cast(target))
                if sum(len(b) for b in pending) >= APPEND_ROWS:
                    tx.append(pa.Table.from_batches(pending))
                    rows += sum(len(b) for b in pending)
                    pending = []
        if pending:
            tx.append(pa.Table.from_batches(pending))
            rows += sum(len(b) for b in pending)
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--table", required=True, choices=sorted(TABLES))
    parser.add_argument("--day", required=True, type=dt.date.fromisoformat, help="UTC day, YYYY-MM-DD")
    args = parser.parse_args()
    print(f"archived {export(args.table, args.day)} {args.table} rows of {args.day}")
