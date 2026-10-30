"""Deletes deleted tenants' rows from the Iceberg archive (and the backfill tables).

    python purge_tenants.py

A tenant deleted on the platform (TenantDeleted) is recorded in ClickHouse's
analytics.deleted_tenants by analytics-service, which deletes its ClickHouse
rows at once. Its archived rows are deleted here: each table's delete is one
Iceberg commit (rewriting only the files that hold the tenant's rows, which are
in its tenant bucket), then the tenant is marked purged. Safe to run again:
deleting rows that are gone changes nothing.

The Flink job appends to the archive as events arrive, and a replay of Kafka
(after a checkpoint reset) appends the tenant's events again while Kafka still
keeps them. So a tenant is purged again on every run until its deletion is
older than Kafka's retention; after that it is skipped.
"""

import datetime as dt
import os

import clickhouse_connect
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.expressions import EqualTo

ARCHIVE_TABLES = ["events", "attributed_baskets", "sessions"]
BACKFILL_TABLES = ["event_totals", "customer_days", "sessions"]
# The analytics topics' retention (14 days, analytics-service) plus a day: until
# then a replay can bring a deleted tenant's events back into the archive.
REPLAYABLE_DAYS = 15


def pending(clickhouse) -> list[tuple[str, str, dt.datetime]]:
    """(tenant_id, name, deleted_at) of the deleted tenants not purged from the archive
    yet, or deleted recently enough that a replay may have archived their events again."""
    return clickhouse.query(
        "SELECT toString(tenant_id), name, deleted_at FROM deleted_tenants FINAL"
        " WHERE archive_purged_at IS NULL OR deleted_at > now64(3, 'UTC') - toIntervalDay({days:UInt32}) ORDER BY deleted_at",
        parameters={"days": REPLAYABLE_DAYS},
    ).result_rows


def purge(catalog, tenant_id: str) -> dict[str, int]:
    archive = os.environ.get("ARCHIVE_NAMESPACE", "archive")
    backfill = os.environ.get("BACKFILL_NAMESPACE", "backfill")
    deleted = {}
    for namespace, names in [(archive, ARCHIVE_TABLES), (backfill, BACKFILL_TABLES)]:
        for name in names:
            try:
                table = catalog.load_table(f"{namespace}.{name}")
            except NoSuchTableError:
                continue
            rows = table.scan(row_filter=EqualTo("tenant_id", tenant_id), selected_fields=("tenant_id",)).to_arrow().num_rows
            if rows:
                table.delete(EqualTo("tenant_id", tenant_id))
            deleted[f"{namespace}.{name}"] = rows
    return deleted


def main() -> None:
    clickhouse = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"])
    catalog = load_catalog("archive")
    for tenant_id, name, deleted_at in pending(clickhouse):
        deleted = purge(catalog, tenant_id)
        clickhouse.insert(
            "deleted_tenants",
            [[tenant_id, name, deleted_at, dt.datetime.now(dt.UTC)]],
            column_names=["tenant_id", "name", "deleted_at", "archive_purged_at"],
        )
        print(f"purged tenant {tenant_id} ({name}) from the archive: {deleted}")


if __name__ == "__main__":
    main()
