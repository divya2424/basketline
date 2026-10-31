"""Deletes deleted tenants' and shoppers' rows from the Iceberg archive (and the backfill tables).

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

A shopper erased by their retailer (user_deleted) is recorded in
analytics.deleted_users the same way, and their rows are purged the same way:
one delete per table for each tenant's deleted shoppers.
"""

import datetime as dt
import os

import clickhouse_connect
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.expressions import And, EqualTo, In

ARCHIVE_TABLES = ["events", "attributed_baskets", "sessions"]
BACKFILL_TABLES = ["event_totals", "customer_days", "sessions"]
# The tables above that hold user IDs.
USER_TABLES = {"events", "attributed_baskets", "sessions", "customer_days"}
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


def pending_users(clickhouse) -> dict[str, list[tuple[str, dt.datetime]]]:
    """Per tenant, (user_id, deleted_at) of the deleted shoppers to purge, on the same terms as pending()."""
    rows = clickhouse.query(
        "SELECT toString(tenant_id), toString(user_id), deleted_at FROM deleted_users FINAL"
        " WHERE archive_purged_at IS NULL OR deleted_at > now64(3, 'UTC') - toIntervalDay({days:UInt32}) ORDER BY tenant_id",
        parameters={"days": REPLAYABLE_DAYS},
    ).result_rows
    users: dict[str, list[tuple[str, dt.datetime]]] = {}
    for tenant_id, user_id, deleted_at in rows:
        users.setdefault(tenant_id, []).append((user_id, deleted_at))
    return users


def purge(catalog, tenant_id: str, user_ids: list[str] | None = None) -> dict[str, int]:
    """Deletes the tenant's rows, or only these shoppers' rows of it."""
    archive = os.environ.get("ARCHIVE_NAMESPACE", "archive")
    backfill = os.environ.get("BACKFILL_NAMESPACE", "backfill")
    rows_of = EqualTo("tenant_id", tenant_id) if user_ids is None else And(EqualTo("tenant_id", tenant_id), In("user_id", user_ids))
    deleted = {}
    for namespace, names in [(archive, ARCHIVE_TABLES), (backfill, BACKFILL_TABLES)]:
        for name in names:
            if user_ids is not None and name not in USER_TABLES:
                continue
            try:
                table = catalog.load_table(f"{namespace}.{name}")
            except NoSuchTableError:
                continue
            rows = table.scan(row_filter=rows_of, selected_fields=("tenant_id",)).to_arrow().num_rows
            if rows:
                table.delete(rows_of)
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
    for tenant_id, users in pending_users(clickhouse).items():
        deleted = purge(catalog, tenant_id, [user_id for user_id, _ in users])
        now = dt.datetime.now(dt.UTC)
        clickhouse.insert(
            "deleted_users",
            [[tenant_id, user_id, deleted_at, now] for user_id, deleted_at in users],
            column_names=["tenant_id", "user_id", "deleted_at", "archive_purged_at"],
        )
        print(f"purged {len(users)} deleted shoppers of tenant {tenant_id} from the archive: {deleted}")


if __name__ == "__main__":
    main()
