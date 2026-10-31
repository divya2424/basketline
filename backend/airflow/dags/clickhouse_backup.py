"""Daily: backs up the ClickHouse tables nothing else can rebuild (the daily totals,
campaign statuses, deleted tenants, backfill runs) to S3
(jobs/backup_clickhouse.py). backend/README.md has the restore.
"""

from datetime import timedelta

import pendulum
from airflow.sdk import dag, task

JOBS_PYTHON = "/opt/jobs/bin/python"


@dag(
    schedule="30 2 * * *",
    start_date=pendulum.datetime(2026, 10, 31, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    default_args={"retries": 3, "retry_delay": timedelta(minutes=10)},
    tags=["clickhouse"],
)
def clickhouse_backup():
    @task.bash
    def backup() -> str:
        return f"{JOBS_PYTHON} /opt/airflow/jobs/backup_clickhouse.py --day {{{{ ds }}}}"

    backup()


clickhouse_backup()
