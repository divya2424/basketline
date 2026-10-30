"""Monthly, on AWS only: compacts and cleans the Iceberg archive tables with Athena.

  OPTIMIZE  merges the small files the nightly appends leave (one per partition
            per append) into large ones, for the last 40 days; older days were
            compacted by earlier runs.
  VACUUM    expires old snapshots and deletes the files no snapshot refers to,
            such as those replaced by a re-run export or left by a failed commit.

Needs the Glue catalog and an `aws_default` connection; paused until enabled.
"""

import pendulum
from airflow.providers.amazon.aws.operators.athena import AthenaOperator
from airflow.sdk import dag


@dag(
    schedule="0 3 1 * *",
    start_date=pendulum.datetime(2026, 10, 30, tz="UTC"),
    catchup=False,
    is_paused_upon_creation=True,
    default_args={"retries": 2},
    tags=["archive"],
)
def archive_maintenance():
    for table in ["events", "attributed_baskets"]:
        common = {"database": "archive", "workgroup": "{{ var.value.get('athena_workgroup', 'primary') }}"}
        optimize = AthenaOperator(
            task_id=f"optimize_{table}",
            query=f"OPTIMIZE {table} REWRITE DATA USING BIN_PACK WHERE event_time >= TIMESTAMP '{{{{ macros.ds_add(ds, -40) }}}} 00:00:00 UTC'",
            **common,
        )
        vacuum = AthenaOperator(task_id=f"vacuum_{table}", query=f"VACUUM {table}", **common)
        optimize >> vacuum


archive_maintenance()
