"""Backs up the ClickHouse tables nothing else can rebuild to S3, one backup per day.

    python backup_clickhouse.py --day 2026-10-31

Raw tables (events, attributed_baskets, sessions) are left out: a replay of
Kafka (14 days) and the Iceberg archive rebuild them. These are not:

  daily_campaign_*   the daily totals, kept forever
  campaigns          campaign statuses (retail.campaign-events.v1 keeps 7 days)
  deleted_tenants    which tenants were deleted (auth.tenant.v1 keeps 7 days,
                     and the tenant is gone from Postgres)
  backfill_runs      the history backfill's runs, for rollback
  invalid_traffic_daily  rejected bot traffic, counted (its events were never kept)

The backup goes to CLICKHOUSE_BACKUP_S3_URL/<day> (default: the archive bucket's
clickhouse-backups/), with the archive's S3 keys locally and ClickHouse's IAM
role on AWS. A day already backed up is left as it is, so a retry is safe.
backend/README.md ("Restoring ClickHouse from a backup") restores one.
"""

import argparse
import datetime as dt
import os

import clickhouse_connect
from clickhouse_connect.driver.exceptions import DatabaseError

TABLES = [
    "daily_campaign_aggregation",
    "daily_campaign_customers_aggregation",
    "daily_campaign_sessions_aggregation",
    "campaigns",
    "deleted_tenants",
    "backfill_runs",
    "invalid_traffic_daily",
]


def backup(day: dt.date) -> str:
    base = os.environ.get("CLICKHOUSE_BACKUP_S3_URL") or f"{os.environ['ARCHIVE_S3_URL'].rstrip('/')}/clickhouse-backups"
    url = f"{base.rstrip('/')}/{day}"
    key, secret = os.environ.get("PYICEBERG_CATALOG__ARCHIVE__S3__ACCESS_KEY_ID"), os.environ.get("PYICEBERG_CATALOG__ARCHIVE__S3__SECRET_ACCESS_KEY")
    credentials = f", '{key}', '{secret}'" if key else ""  # On AWS: ClickHouse's IAM role.
    # A backup copies whole tables, so it can take a while.
    ch = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"], send_receive_timeout=3600)
    existing = {row[0] for row in ch.query("SELECT name FROM system.tables WHERE database = currentDatabase()").result_rows}
    # backfill_runs exists once a history backfill has run.
    tables = ", ".join(f"TABLE {name}" for name in TABLES if name in existing)
    try:
        ch.command(f"BACKUP {tables} TO S3('{url}'{credentials})")
    except DatabaseError as error:
        if "BACKUP_ALREADY_EXISTS" not in str(error):
            raise
        return f"{url} already exists"
    return url


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--day", required=True, type=dt.date.fromisoformat)
    print(f"backed up to {backup(parser.parse_args().day)}")
