"""Backs up the ClickHouse tables nothing else can rebuild to S3, one backup per day.

    python backup_clickhouse.py --day 2026-10-31

The staging tables (events, attributed_baskets, sessions) are left out: they hold 3
days, which a replay of Kafka (14 days) rebuilds. These can't be rebuilt:

  daily_campaign_*   the daily totals, kept forever
  deleted_tenants    which tenants were deleted (auth.tenant.v1 keeps 7 days,
                     and the tenant is gone from Postgres), and their lake purges
  deleted_users      which shoppers were erased, and their lake purges
  backfill_runs      the history backfills, what each recomputed

The backup goes to CLICKHOUSE_BACKUP_S3_URL/<day>, with BACKUP_S3_ACCESS_KEY_ID
and BACKUP_S3_SECRET_ACCESS_KEY locally and ClickHouse's IAM role on AWS. A day already backed up is left as it is, so a retry is safe.
basketline/README.md ("Restoring ClickHouse from a backup") restores one.
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
    "daily_campaign_product_aggregation",
    "campaign_products",
    "deleted_tenants",
    "deleted_users",
    "backfill_runs",
]


def backup(day: dt.date) -> str:
    url = f"{os.environ['CLICKHOUSE_BACKUP_S3_URL'].rstrip('/')}/{day}"
    key, secret = os.environ.get("BACKUP_S3_ACCESS_KEY_ID"), os.environ.get("BACKUP_S3_SECRET_ACCESS_KEY")
    credentials = f", '{key}', '{secret}'" if key else ""  # On AWS: ClickHouse's IAM role.
    # A backup copies whole tables, so it can take a while.
    ch = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"], send_receive_timeout=3600)
    tables = ", ".join(f"TABLE {name}" for name in TABLES)
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
