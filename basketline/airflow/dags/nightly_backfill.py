"""Nightly: recomputes the newest settled day (3 days ago) from the data lake (jobs/backfill_daily.py).

Live counting drops events that arrive too late for their session (more than 10
minutes behind the newest); events arrive up to 2 days late. Recomputing the day
once no event can still change it counts them, and makes every daily table exact.
It waits while the lake is behind (Kafka Connect or its storage down), so a partial
lake never replaces correct live counts; the retries give it hours to catch up.
"""

from datetime import timedelta

import pendulum
from airflow.sdk import dag, task

JOBS_PYTHON = "/opt/jobs/bin/python"


@dag(
    schedule="0 3 * * *",
    start_date=pendulum.datetime(2026, 11, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    default_args={"retries": 6, "retry_delay": timedelta(minutes=30)},
    tags=["clickhouse", "lake"],
)
def nightly_backfill():
    @task.bash
    def backfill() -> str:
        day = "$(date -u -d '3 days ago' +%F)"
        return f"{JOBS_PYTHON} /opt/airflow/jobs/backfill_daily.py --from {day} --to {day} --only-if-lake-caught-up"

    backfill()


nightly_backfill()
