"""On demand: recomputes closed months of the daily tables from the raw Iceberg
archive with the current rules, for one, several or all tenants, and swaps them
in only at the end (jobs/backfill/).

    validate → spark_backfill (local or EMR Serverless) → prepare → check → swap

Nothing live changes before swap, and swap runs only with apply=true; without
it, the run is a dry run whose prepare task logs the before/after report. swap
replaces every touched month of every table back to back, each atomically, and
puts back those already swapped if one fails. Trigger it from the UI (Trigger
DAG w/ config) or:

    airflow dags trigger history_backfill --conf '{"from": "2026-08-01", "to": "2026-09-01", "tenants": "all", "apply": false}'

The Airflow variable backfill_runtime picks where Spark runs: "local" (default:
PySpark in this container) or "emr" (EMR Serverless, with the variables
emr_serverless_application_id, emr_serverless_role_arn and backfill_script_s3).
"""

import pendulum
from airflow.models.param import Param
from airflow.providers.amazon.aws.operators.emr import EmrServerlessStartJobOperator
from airflow.sdk import Variable, dag, task

JOBS_PYTHON = "/opt/jobs/bin/python"
JOBS = "/opt/airflow/jobs/backfill"
RUN = "--run-id {{ run_id }}"
RANGE = "--from {{ params['from'] }} --to {{ params['to'] }} --tenants {{ params['tenants'] }}"
SPARK_ARGS = f"{RUN} {RANGE}{{% if params['allow_partial_context'] %}} --allow-partial-context{{% endif %}}"


@dag(
    schedule=None,
    start_date=pendulum.datetime(2026, 10, 1, tz="UTC"),
    catchup=False,
    # Runs swap the same month partitions, so one at a time.
    max_active_runs=1,
    is_paused_upon_creation=False,
    params={
        "from": Param("2026-08-01", type="string", format="date", description="First UTC day to recompute"),
        "to": Param("2026-09-01", type="string", format="date", description="The day after the last one"),
        "tenants": Param("all", type="string", description="all, or comma-separated tenant UUIDs"),
        "apply": Param(False, type="boolean", description="Swap the recomputed months in; false is a dry run"),
        "allow_partial_context": Param(False, type="boolean", description="Run even if the archive lacks the 7 days before 'from'"),
    },
    tags=["archive", "backfill"],
)
def history_backfill():
    @task.bash
    def validate() -> str:
        return f"{JOBS_PYTHON} {JOBS}/load_backfill.py validate {RUN} {RANGE}"

    @task.branch
    def runtime() -> str:
        return "spark_emr" if Variable.get("backfill_runtime", default="local") == "emr" else "spark_local"

    @task.bash
    def spark_local() -> str:
        return f"{JOBS_PYTHON} {JOBS}/spark_backfill.py {SPARK_ARGS}"

    # The same script, on EMR Serverless: the Glue catalog and the job role's S3 access.
    spark_emr = EmrServerlessStartJobOperator(
        task_id="spark_emr",
        application_id="{{ var.value.emr_serverless_application_id }}",
        execution_role_arn="{{ var.value.emr_serverless_role_arn }}",
        job_driver={
            "sparkSubmit": {
                "entryPoint": "{{ var.value.backfill_script_s3 }}",
                "entryPointArguments": SPARK_ARGS.split(" "),
                # EMR's own Iceberg runtime; the catalog is configured by spark_session() from these.
                "sparkSubmitParameters": "--conf spark.jars=/usr/share/aws/iceberg/lib/iceberg-spark3-runtime.jar"
                " --conf spark.emr-serverless.driverEnv.PYICEBERG_CATALOG__ARCHIVE__TYPE=glue"
                " --conf spark.emr-serverless.driverEnv.PYICEBERG_CATALOG__ARCHIVE__WAREHOUSE={{ var.value.archive_warehouse }}"
                " --conf spark.emr-serverless.driverEnv.ARCHIVE_NAMESPACE={{ var.value.get('archive_namespace', 'archive') }}"
                " --conf spark.emr-serverless.driverEnv.BACKFILL_NAMESPACE={{ var.value.get('backfill_namespace', 'backfill') }}",
            }
        },
        configuration_overrides={},
    )

    @task.bash(trigger_rule="none_failed_min_one_success")
    def prepare() -> str:
        return f"{JOBS_PYTHON} {JOBS}/load_backfill.py prepare {RUN}"

    @task.bash
    def check() -> str:
        return f"{JOBS_PYTHON} {JOBS}/load_backfill.py check {RUN}"

    @task.short_circuit
    def apply(**context) -> bool:
        return bool(context["params"]["apply"])

    @task.bash
    def swap() -> str:
        return f"{JOBS_PYTHON} {JOBS}/load_backfill.py swap {RUN}"

    spark = [spark_local(), spark_emr]
    validate() >> runtime() >> spark
    spark >> prepare() >> check() >> apply() >> swap()


history_backfill()
