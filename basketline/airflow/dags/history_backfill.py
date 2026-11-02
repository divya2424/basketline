"""On demand: recomputes ClickHouse's daily tables for past days from the data lake (jobs/backfill_daily.py).

Trigger it with the days (from_day, to_day: UTC dates, at most 3 days ago), and
optionally tenants and daily tables to limit it to; or with rollback to undo the
latest run. A correction of past days, or a new daily table's history.
"""

import shlex

import pendulum
from airflow.sdk import Param, dag, task

JOBS_PYTHON = "/opt/jobs/bin/python"


@dag(
    schedule=None,
    start_date=pendulum.datetime(2026, 11, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    params={
        "from_day": Param("", type="string", description="First day to recompute (YYYY-MM-DD, UTC)"),
        "to_day": Param("", type="string", description="Last day to recompute (YYYY-MM-DD, UTC), at most 3 days ago"),
        "tenants": Param([], type="array", items={"type": "string"}, description="Only these tenants (empty: all)"),
        "tables": Param([], type="array", items={"type": "string"}, description="Only these daily tables (empty: all)"),
        "rollback": Param(False, type="boolean", description="Undo the latest backfill instead"),
    },
    tags=["clickhouse", "lake"],
)
def history_backfill():
    @task.bash
    def backfill(params=None) -> str:
        if params["rollback"]:
            args = ["--rollback"]
        else:
            args = ["--from", params["from_day"], "--to", params["to_day"]]
            args += [arg for tenant in params["tenants"] for arg in ("--tenant", tenant)]
            args += [arg for table in params["tables"] for arg in ("--table", table)]
        return shlex.join([JOBS_PYTHON, "/opt/airflow/jobs/backfill_daily.py", *args])

    backfill()


history_backfill()
