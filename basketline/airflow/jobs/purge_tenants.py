"""Deletes deleted tenants' and erased shoppers' rows from the data lake's Iceberg tables.

    python purge_tenants.py
    python purge_tenants.py --tenant <uuid>   # one tenant's rows now, e.g. the load test's (loadtest/cleanup.sql)

Kafka Connect (basketline/connect) appends each topic to its table in the lake
namespace, its payload flattened into columns, partitioned by tenant
(payload_tenantId) and hour. A tenant deleted on the platform (TenantDeleted) is
recorded in ClickHouse's analytics.deleted_tenants by ingestion-service, which
deletes its ClickHouse rows at once; its lake rows are deleted here, one Iceberg
commit per table (whole files: the tenant is a partition).

A shopper erased by their store (user_deleted) is recorded in analytics.deleted_users
the same way, and their rows (payload_userId) are deleted from the tables that
hold user IDs: Iceberg rewrites only the files that have them.

Every deleted tenant and shopper is purged on every run, not only new ones: Kafka
still holds their events (14 days, and the compacted catalog and campaign topics
until compaction), so a replay of the connector would append them again. A run
with nothing to delete only reads table metadata. Safe to run again.
"""

import argparse
import datetime as dt
import os

import clickhouse_connect
from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.expressions import In

LAKE_TABLES = ["interactions", "identity_events", "catalog_events", "campaign_events", "campaign_products", "tenants"]
# The tables above whose events name a shopper.
USER_TABLES = ["interactions", "identity_events"]


def purge(catalog, field: str, ids: list[str], tables: list[str]) -> dict[str, int]:
    """Deletes the rows whose `field` is one of `ids` from each table; the rows deleted per table."""
    namespace = os.environ.get("LAKE_NAMESPACE", "lake")
    rows_of = In(field, ids)
    deleted = {}
    for name in tables:
        try:
            table = catalog.load_table(f"{namespace}.{name}")
        except NoSuchTableError:  # Created with its topic's first message.
            continue
        rows = table.scan(row_filter=rows_of, selected_fields=("_kafka_metadata_offset",)).to_arrow().num_rows
        if rows:
            table.delete(rows_of)
        deleted[name] = rows
    return deleted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", help="delete this tenant's rows only, without it being deleted on the platform")
    tenant = parser.parse_args().tenant
    catalog = load_catalog("lake")
    if tenant:
        print(f"purged tenant {tenant} from the lake: {purge(catalog, 'payload_tenantId', [tenant.lower()], LAKE_TABLES)}")
        return
    clickhouse = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"])
    now = dt.datetime.now(dt.UTC)

    tenants = clickhouse.query("SELECT toString(tenant_id), name, deleted_at, lake_purged_at FROM deleted_tenants FINAL").result_rows
    if tenants:
        print(f"purged {len(tenants)} deleted tenants from the lake: {purge(catalog, 'payload_tenantId', [t[0] for t in tenants], LAKE_TABLES)}")
        first = [[tenant_id, name, deleted_at, now] for tenant_id, name, deleted_at, purged_at in tenants if purged_at is None]
        if first:
            clickhouse.insert("deleted_tenants", first, column_names=["tenant_id", "name", "deleted_at", "lake_purged_at"])

    users = clickhouse.query("SELECT toString(tenant_id), toString(user_id), deleted_at, lake_purged_at FROM deleted_users FINAL").result_rows
    if users:
        print(f"purged {len(users)} erased shoppers from the lake: {purge(catalog, 'payload_userId', [u[1] for u in users], USER_TABLES)}")
        first = [[tenant_id, user_id, deleted_at, now] for tenant_id, user_id, deleted_at, purged_at in users if purged_at is None]
        if first:
            clickhouse.insert("deleted_users", first, column_names=["tenant_id", "user_id", "deleted_at", "lake_purged_at"])


if __name__ == "__main__":
    main()
