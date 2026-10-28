FROM apache/spark:4.0.4-python3 AS base

# The Kafka source is a JVM package: fetched at build time so the job starts
# without network access. Versions match Spark 4.0.4 / Scala 2.13.
ARG MAVEN=https://repo1.maven.org/maven2
USER root
RUN cd /opt/spark/jars \
 && curl -fsSLO $MAVEN/org/apache/spark/spark-sql-kafka-0-10_2.13/4.0.4/spark-sql-kafka-0-10_2.13-4.0.4.jar \
 && curl -fsSLO $MAVEN/org/apache/spark/spark-token-provider-kafka-0-10_2.13/4.0.4/spark-token-provider-kafka-0-10_2.13-4.0.4.jar \
 && curl -fsSLO $MAVEN/org/apache/kafka/kafka-clients/3.9.1/kafka-clients-3.9.1.jar \
 && curl -fsSLO $MAVEN/org/apache/commons/commons-pool2/2.12.0/commons-pool2-2.12.0.jar \
 && mkdir -p /checkpoints && chown spark /checkpoints

# The pipeline package and its Python dependencies (pyspark comes from the image).
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir . && rm -rf /root/.cache

# `docker build --target test .` runs the unit tests against the image's Spark.
FROM base AS test
ENV PYTHONPATH=/opt/spark/python/lib/pyspark.zip:/opt/spark/python/lib/py4j-0.10.9.9-src.zip
RUN pip install --no-cache-dir pytest==9.1.1
COPY tests ./tests
RUN python3 -m pytest -q

FROM base AS runtime
USER spark
CMD ["/opt/spark/bin/spark-submit", "--master", "local[2]", "--conf", "spark.sql.session.timeZone=UTC", "/app/src/event_pipeline/main.py"]
