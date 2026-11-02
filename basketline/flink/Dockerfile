FROM flink:2.2.1-java17

# The connectors are fetched at build time so the job starts without network
# access: Kafka (5.0.0-2.2 is the release for Flink 2.2), and for the Iceberg
# archive the Iceberg runtime for Flink 2.2, its AWS bundle (S3FileIO, Glue), the
# Postgres driver (the JDBC catalog locally) and the Hadoop client classes the
# Iceberg connector needs. Iceberg 1.12.0, as in the Airflow jobs.
ARG MAVEN=https://repo1.maven.org/maven2
ARG ICEBERG=1.12.0
ARG HADOOP=3.4.1
USER root
RUN cd /opt/flink/lib \
 && curl -fsSLO $MAVEN/org/apache/flink/flink-sql-connector-kafka/5.0.0-2.2/flink-sql-connector-kafka-5.0.0-2.2.jar \
 && curl -fsSLO $MAVEN/org/apache/iceberg/iceberg-flink-runtime-2.2/$ICEBERG/iceberg-flink-runtime-2.2-$ICEBERG.jar \
 && curl -fsSLO $MAVEN/org/apache/iceberg/iceberg-aws-bundle/$ICEBERG/iceberg-aws-bundle-$ICEBERG.jar \
 && curl -fsSLO $MAVEN/org/postgresql/postgresql/42.7.14/postgresql-42.7.14.jar \
 && curl -fsSLO $MAVEN/org/apache/hadoop/hadoop-client-api/$HADOOP/hadoop-client-api-$HADOOP.jar \
 && curl -fsSLO $MAVEN/org/apache/hadoop/hadoop-client-runtime/$HADOOP/hadoop-client-runtime-$HADOOP.jar \
 && mkdir -p /checkpoints && chown flink:flink /checkpoints

COPY config.yaml /opt/flink/conf/config.yaml
COPY run.sh /opt/job/
COPY sql /opt/job/sql

USER flink
ENTRYPOINT ["/opt/job/run.sh"]
