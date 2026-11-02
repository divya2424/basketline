# Airflow plus the jobs it runs. The jobs get their own virtualenv, so their
# dependencies never conflict with Airflow's.
FROM apache/airflow:3.3.2-python3.12

USER root
RUN mkdir -p /opt/jobs && chown airflow /opt/jobs
USER airflow

COPY requirements.txt /opt/jobs-requirements.txt
RUN python -m venv /opt/jobs && /opt/jobs/bin/pip install --no-cache-dir -r /opt/jobs-requirements.txt

COPY jobs /opt/airflow/jobs
COPY dags /opt/airflow/dags
