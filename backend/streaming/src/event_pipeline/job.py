from pyspark.sql import SparkSession

from event_pipeline.config import settings
from event_pipeline.sinks import write_batch
from event_pipeline.transformations import parse_events


def build_spark() -> SparkSession:
    return (
        SparkSession.builder.appName("events-to-clickhouse")
        .config("spark.sql.shuffle.partitions", settings.spark_shuffle_partitions)
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )


def run() -> None:
    """Start the streaming query.

    Offsets: Spark never auto-commits to Kafka. Each batch's offsets are written
    to the checkpoint first, and the batch is marked done only after write_batch
    (the ClickHouse insert) succeeds. After a crash the query restarts from the
    checkpoint and re-runs the unfinished batch with the same rows, in the same
    order; ClickHouse skips the identical inserts, so each event lands once.
    """
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")

    try:
        kafka_df = (
            spark.readStream.format("kafka")
            .option("kafka.bootstrap.servers", settings.kafka_bootstrap_servers)
            .option("subscribePattern", settings.kafka_topic_pattern)
            .option("groupIdPrefix", settings.kafka_group_id)
            .option("startingOffsets", settings.kafka_starting_offsets)
            .option("maxOffsetsPerTrigger", settings.kafka_max_offsets_per_trigger)
            .option("failOnDataLoss", "false")
            .load()
        )

        query = (
            parse_events(kafka_df)
            .writeStream.outputMode("append")
            .foreachBatch(write_batch)
            .option("checkpointLocation", settings.checkpoint_location)
            .trigger(processingTime=settings.spark_trigger_interval)
            .start()
        )
        query.awaitTermination()
    finally:
        spark.stop()
