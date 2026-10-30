# Airflow plus the jobs it runs. The jobs get their own virtualenv, so their
# dependencies never conflict with Airflow's.
FROM apache/airflow:3.3.2-python3.12

# The history backfill runs Spark in local mode here (jobs/backfill): a JRE, and
# the Iceberg runtime, AWS bundle (S3FileIO, Glue) and Postgres driver (the JDBC
# catalog) for Spark 4.1, fetched at build time.
ARG MAVEN=https://repo1.maven.org/maven2
ARG ICEBERG=1.12.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/java-17 \
 && mkdir -p /opt/jobs /opt/spark-jars && chown airflow /opt/jobs \
 && cd /opt/spark-jars \
 && curl -fsSLO $MAVEN/org/apache/iceberg/iceberg-spark-runtime-4.1_2.13/$ICEBERG/iceberg-spark-runtime-4.1_2.13-$ICEBERG.jar \
 && curl -fsSLO $MAVEN/org/apache/iceberg/iceberg-aws-bundle/$ICEBERG/iceberg-aws-bundle-$ICEBERG.jar \
 && curl -fsSLO $MAVEN/org/postgresql/postgresql/42.7.14/postgresql-42.7.14.jar
ENV JAVA_HOME=/usr/lib/jvm/java-17 \
    SPARK_JARS=/opt/spark-jars/iceberg-spark-runtime-4.1_2.13-1.12.0.jar,/opt/spark-jars/iceberg-aws-bundle-1.12.0.jar,/opt/spark-jars/postgresql-42.7.14.jar
USER airflow

COPY requirements.txt /opt/jobs-requirements.txt
RUN python -m venv /opt/jobs && /opt/jobs/bin/pip install --no-cache-dir -r /opt/jobs-requirements.txt

COPY jobs /opt/airflow/jobs
COPY dags /opt/airflow/dags
