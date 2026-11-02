"""The lake purge against the running stack's Postgres catalog and S3:

    docker compose up -d postgres archive-storage
    pnpm test:airflow

Its tables are in the lake_test namespace, shaped like the ones Kafka Connect
creates (the envelope with its payload flattened into columns, partitioned by
tenant), so the real lake tables are untouched.
"""

import os
import sys
import uuid
from pathlib import Path

# Before importing PyIceberg, which reads its configuration from the environment then.
for name, value in {
    "PYICEBERG_CATALOG__LAKE__TYPE": "sql",
    "PYICEBERG_CATALOG__LAKE__URI": "postgresql+psycopg2://iceberg_svc:iceberg_svc_dev@localhost:5432/iceberg_catalog_db",
    "PYICEBERG_CATALOG__LAKE__WAREHOUSE": "s3://basketline-pipeline",
    "PYICEBERG_CATALOG__LAKE__S3__ENDPOINT": "http://localhost:8333",
    "PYICEBERG_CATALOG__LAKE__S3__REGION": "us-east-1",
    "PYICEBERG_CATALOG__LAKE__S3__ACCESS_KEY_ID": "archive",
    "PYICEBERG_CATALOG__LAKE__S3__SECRET_ACCESS_KEY": "archive_dev",
}.items():
    os.environ.setdefault(name, value)
os.environ["LAKE_NAMESPACE"] = "lake_test"

import pyarrow as pa  # noqa: E402
import pytest  # noqa: E402
from pyiceberg.catalog import load_catalog  # noqa: E402
from pyiceberg.partitioning import PartitionField, PartitionSpec  # noqa: E402
from pyiceberg.schema import Schema  # noqa: E402
from pyiceberg.transforms import IdentityTransform  # noqa: E402
from pyiceberg.types import LongType, NestedField, StringType  # noqa: E402

sys.path.insert(0, str(Path(__file__).parents[1] / "jobs"))
from purge_tenants import purge  # noqa: E402

SCHEMA = Schema(
    NestedField(1, "eventType", StringType()),
    NestedField(2, "_kafka_metadata_offset", LongType()),
    NestedField(3, "payload_tenantId", StringType()),
    NestedField(4, "payload_userId", StringType()),
)
ARROW = pa.schema([
    pa.field("eventType", pa.string()),
    pa.field("_kafka_metadata_offset", pa.int64()),
    pa.field("payload_tenantId", pa.string()),
    pa.field("payload_userId", pa.string()),
])


@pytest.fixture
def tables():
    catalog = load_catalog("lake")
    catalog.create_namespace_if_not_exists("lake_test")
    spec = PartitionSpec(PartitionField(source_id=3, field_id=1000, transform=IdentityTransform(), name="payload_tenantId"))
    names = ["interactions", "tenants"]
    for name in names:
        if catalog.table_exists(f"lake_test.{name}"):
            catalog.purge_table(f"lake_test.{name}")
        catalog.create_table(f"lake_test.{name}", SCHEMA, partition_spec=spec)
    yield catalog
    for name in names:
        catalog.purge_table(f"lake_test.{name}")


def rows(catalog, name: str) -> list[tuple[str, str]]:
    table = catalog.load_table(f"lake_test.{name}").scan().to_arrow()
    return sorted((row["payload_tenantId"], row["payload_userId"]) for row in table.to_pylist())


def append(catalog, name: str, events: list[tuple[str, str]]) -> None:
    catalog.load_table(f"lake_test.{name}").append(pa.Table.from_pylist(
        [{"eventType": "e", "_kafka_metadata_offset": i, "payload_tenantId": t, "payload_userId": u} for i, (t, u) in enumerate(events)],
        schema=ARROW,
    ))


def test_deletes_a_tenants_rows_from_every_table_and_a_shoppers_from_theirs(tables):
    gone, kept = str(uuid.uuid4()), str(uuid.uuid4())
    erased, shopper = str(uuid.uuid4()), str(uuid.uuid4())
    append(tables, "interactions", [(gone, shopper), (kept, erased), (kept, shopper)])
    append(tables, "tenants", [(gone, None), (kept, None)])

    # campaign_products has no table yet (no message so far): skipped.
    assert purge(tables, "payload_tenantId", [gone], ["interactions", "tenants", "campaign_products"]) == {"interactions": 1, "tenants": 1}
    assert rows(tables, "interactions") == sorted([(kept, erased), (kept, shopper)])
    assert rows(tables, "tenants") == [(kept, None)]

    assert purge(tables, "payload_userId", [erased], ["interactions"]) == {"interactions": 1}
    assert rows(tables, "interactions") == [(kept, shopper)]
    # Again: nothing left to delete, and no new commit.
    snapshot = tables.load_table("lake_test.interactions").current_snapshot().snapshot_id
    assert purge(tables, "payload_userId", [erased], ["interactions"]) == {"interactions": 0}
    assert tables.load_table("lake_test.interactions").current_snapshot().snapshot_id == snapshot
