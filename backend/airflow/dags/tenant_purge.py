"""Daily: deletes deleted tenants' rows from the Iceberg archive (jobs/purge_tenants.py).

Deleting a tenant on the platform removes its data from every service and from
ClickHouse at once; its archived files are rewritten here, and again on every
run while a replay of Kafka could archive its events again (purge_tenants.py).
Trigger it by hand to purge sooner.
"""

from datetime import timedelta

import pendulum
from airflow.sdk import dag, task

JOBS_PYTHON = "/opt/jobs/bin/python"


@dag(
    schedule="0 2 * * *",
    start_date=pendulum.datetime(2026, 10, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    default_args={"retries": 3, "retry_delay": timedelta(minutes=10)},
    tags=["archive"],
)
def tenant_purge():
    @task.bash
    def purge() -> str:
        return f"{JOBS_PYTHON} /opt/airflow/jobs/purge_tenants.py"

    purge()


tenant_purge()
