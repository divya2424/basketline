FROM flink:2.2.1-java17

# The Kafka connector is fetched at build time so the job starts without network
# access. 5.0.0-2.2 is the connector release for Flink 2.2.
ARG MAVEN=https://repo1.maven.org/maven2
USER root
RUN cd /opt/flink/lib \
 && curl -fsSLO $MAVEN/org/apache/flink/flink-sql-connector-kafka/5.0.0-2.2/flink-sql-connector-kafka-5.0.0-2.2.jar \
 && mkdir -p /checkpoints && chown flink:flink /checkpoints

COPY config.yaml /opt/flink/conf/config.yaml
COPY run.sh /opt/job/
COPY sql /opt/job/sql

USER flink
ENTRYPOINT ["/opt/job/run.sh"]
