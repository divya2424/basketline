# Kafka Connect with the Apache Iceberg sink: writes Basketline's topics to
# Iceberg tables in the data lake (connect/lake-sink.json).
FROM maven:3.9.11-eclipse-temurin-21 AS plugin
WORKDIR /build
COPY pom.xml .
RUN mvn -q dependency:copy-dependencies -DoutputDirectory=/plugins/iceberg-sink -DincludeScope=runtime

# The broker's image: the same Kafka release, and its connect-distributed.sh.
FROM apache/kafka:3.9.1
COPY --from=plugin /plugins /opt/connect-plugins
COPY connect-distributed.properties start.sh /opt/connect/
CMD ["/opt/connect/start.sh"]
