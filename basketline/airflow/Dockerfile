# Airflow plus the jobs it runs. The jobs get their own virtualenv, so their
# dependencies never conflict with Airflow's. Built from basketline/ (docker-compose.yml),
# for the ClickHouse schema the history backfill builds its scratch tables from.
FROM apache/airflow:3.3.2-python3.12

USER root
RUN mkdir -p /opt/jobs && chown airflow /opt/jobs
USER airflow

COPY airflow/requirements.txt /opt/jobs-requirements.txt
RUN python -m venv /opt/jobs && /opt/jobs/bin/pip install --no-cache-dir -r /opt/jobs-requirements.txt

COPY infra/clickhouse/01_tables.sql infra/clickhouse/02_materialized_views.sql /opt/airflow/clickhouse/
COPY airflow/jobs /opt/airflow/jobs
COPY airflow/dags /opt/airflow/dags
