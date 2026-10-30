"""Nightly: copies the raw events of the day seven days ago from ClickHouse to the
Iceberg archive (jobs/export_archive.py), one task per table.

Seven days, because analytics-service accepts events up to 5 days late: the day
is complete from midnight five days after it, and the extra day lets events
accepted just before then reach ClickHouse even when Flink or ClickHouse is
behind. ClickHouse keeps raw events 20 days, so a failed run can be retried or
backfilled for almost two weeks before the day is gone. A run that is
missed while the scheduler is down is caught up when it is back (catchup).

start_date is a week before the first deployment, so its first catch-up also
archives the older days ClickHouse already held then.
"""

from datetime import timedelta

import pendulum
from airflow.sdk import dag, task

JOBS_PYTHON = "/opt/jobs/bin/python"
EXPORT = "/opt/airflow/jobs/export_archive.py"


@dag(
    # After the 00:30 nightly check in ClickHouse; independent of it (raw rows only).
    schedule="0 1 * * *",
    start_date=pendulum.datetime(2026, 10, 23, tz="UTC"),
    catchup=True,
    # One run at a time: runs commit to the same Iceberg tables.
    max_active_runs=1,
    is_paused_upon_creation=False,
    default_args={"retries": 3, "retry_delay": timedelta(minutes=10)},
    tags=["archive"],
)
def archive_export():
    @task.bash
    def export(table: str) -> str:
        # ds is the run's date (UTC); the day exported is seven days before it.
        return f"{JOBS_PYTHON} {EXPORT} --table {table} --day {{{{ macros.ds_add(ds, -7) }}}}"

    export.expand(table=["events", "attributed_baskets", "sessions"])


archive_export()
