"""Daily, on AWS only: compacts and cleans the Iceberg archive tables with Athena.

  OPTIMIZE  merges the small files the Flink job leaves (it commits at every
            checkpoint, once a minute, a file per partition it wrote to) into
            large ones, for the last 7 days: events arrive at most 5 days late,
            so older days get no new files and were compacted by earlier runs.
  VACUUM    expires old snapshots and deletes the files no snapshot refers to,
            such as those replaced by a re-run export or left by a failed commit.

Needs the Glue catalog and an `aws_default` connection; paused until enabled.
"""

import pendulum
from airflow.providers.amazon.aws.operators.athena import AthenaOperator
from airflow.sdk import dag


@dag(
    schedule="0 3 * * *",
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
            query=f"OPTIMIZE {table} REWRITE DATA USING BIN_PACK WHERE event_time >= TIMESTAMP '{{{{ macros.ds_add(ds, -7) }}}} 00:00:00 UTC'",
            **common,
        )
        vacuum = AthenaOperator(task_id=f"vacuum_{table}", query=f"VACUUM {table}", **common)
        optimize >> vacuum


archive_maintenance()
