"""Imports a tenant's past interactions into the data lake, for a history backfill.

    python import_history.py --tenant <uuid> < events.jsonl
    python backfill_daily.py --from <day after the first imported> --to <last imported> --tenant <uuid>

For a tenant's history from before it sent events to Basketline (a retailer's
past data, or demo data): ingestion-service takes events at most 2 days old, so
older ones can't go through the API. Each line is one interaction as
ingestion-service publishes it (retail.interactions.v1's payload): eventId,
eventName, tenantId, storeId, campaignId, productId, userId, userType,
clientType, timestamp, receivedAt, pageName, featureName.

They are appended to the lake's interactions table as Kafka Connect writes it
(basketline/connect: the payload flattened into payload_* columns), with the
Kafka time set to when each was received: the backfill reads the lake by Kafka
time, and the lake then holds those days. ClickHouse isn't touched;
backfill_daily.py recomputes the days from the lake with the live rules.

Refused: rows of another tenant, events from the last 2 days (the API still
takes those), and a tenant whose history was imported before (producer
"history-import"), so a re-run can't count it twice.
"""

import argparse
import datetime as dt
import json
import os
import sys
import uuid

import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.expressions import And, EqualTo
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import HourTransform, IdentityTransform
from pyiceberg.types import LongType, NestedField, StringType, TimestamptzType

TOPIC = "retail.interactions.v1"
PRODUCER = "history-import"
FIELDS = ["eventId", "eventName", "tenantId", "storeId", "campaignId", "productId", "userId", "userType", "clientType",
          "timestamp", "receivedAt", "pageName", "featureName"]
# The days ingestion-service still takes events for (its MAX_EVENT_AGE_MS).
API_DAYS = 2

# Kafka Connect creates the table with its topic's first commit (hourly); before
# that, the columns the backfill reads, partitioned as Connect partitions it
# (connect/lake-sink.json). Connect adds its other columns as it writes.
NEW_TABLE = Schema(
    *[NestedField(i + 1, f"payload_{name}", StringType()) for i, name in enumerate(FIELDS)],
    NestedField(len(FIELDS) + 1, "_kafka_metadata_topic", StringType()),
    NestedField(len(FIELDS) + 2, "_kafka_metadata_timestamp", TimestamptzType()),
    NestedField(len(FIELDS) + 3, "_kafka_metadata_offset", LongType()),
    NestedField(len(FIELDS) + 4, "producer", StringType()),
)


def lake_table(catalog):
    name = f"{os.environ.get('LAKE_NAMESPACE', 'lake')}.interactions"
    try:
        return catalog.load_table(name)
    except NoSuchTableError:
        tenant_field = NEW_TABLE.find_field("payload_tenantId").field_id
        time_field = NEW_TABLE.find_field("_kafka_metadata_timestamp").field_id
        spec = PartitionSpec(PartitionField(source_id=tenant_field, field_id=1000, transform=IdentityTransform(), name="payload_tenantId"),
                             PartitionField(source_id=time_field, field_id=1001, transform=HourTransform(), name="_kafka_metadata_timestamp_hour"))
        catalog.create_namespace_if_not_exists(name.split(".")[0])
        return catalog.create_table(name, NEW_TABLE, partition_spec=spec)


def rows_of(events: list[dict], tenant: str, today: dt.date) -> list[dict]:
    """The lake rows for the events; raises on any the import refuses."""
    oldest_api_day = today - dt.timedelta(days=API_DAYS)
    rows = []
    for n, event in enumerate(events, 1):
        if str(event.get("tenantId", "")).lower() != tenant:
            raise ValueError(f"line {n}: tenantId isn't {tenant}")
        received = dt.datetime.fromisoformat(event.get("receivedAt") or event["timestamp"])
        if received.date() >= oldest_api_day:
            raise ValueError(f"line {n}: {received.date()} is in the last {API_DAYS} days: send it through the API")
        rows.append({
            **{f"payload_{name}": None if event.get(name) is None else str(event[name]) for name in FIELDS},
            "payload_tenantId": tenant,
            "_kafka_metadata_topic": TOPIC,
            "_kafka_metadata_timestamp": received,
            "_kafka_metadata_offset": -1,
            "producer": PRODUCER,
            "eventId": str(event.get("eventId") or uuid.uuid4()),
            "eventType": "AnalyticsEventRecorded",
            "occurredAt": event["timestamp"],
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", required=True, help="the tenant whose history this is")
    tenant = parser.parse_args().tenant.lower()
    table = lake_table(load_catalog("lake"))
    if "producer" in table.schema().column_names and table.scan(
            row_filter=And(EqualTo("payload_tenantId", tenant), EqualTo("producer", PRODUCER)), selected_fields=("_kafka_metadata_offset",), limit=1).to_arrow().num_rows:
        print(f"tenant {tenant} already has imported history; nothing imported", file=sys.stderr)
        sys.exit(3)
    rows = rows_of([json.loads(line) for line in sys.stdin if line.strip()], tenant, dt.datetime.now(dt.UTC).date())
    if not rows:
        sys.exit("no events on stdin")
    schema = table.schema().as_arrow()
    table.append(pa.Table.from_pylist([{name: row.get(name) for name in schema.names} for row in rows], schema=schema))
    days = sorted({row["_kafka_metadata_timestamp"].date() for row in rows})
    print(f"imported {len(rows)} events for tenant {tenant}, {days[0]} to {days[-1]}")


if __name__ == "__main__":
    main()
