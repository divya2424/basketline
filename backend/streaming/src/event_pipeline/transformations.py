from pyspark.sql import Column, DataFrame
from pyspark.sql import functions as F

from event_pipeline.schemas import ENVELOPE_SCHEMA

UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


def _uuid_or_null(column: Column) -> Column:
    # A malformed optional ID becomes null instead of failing the ClickHouse insert.
    return F.when(column.rlike(UUID_PATTERN), F.lower(column))


def parse_events(kafka_df: DataFrame) -> DataFrame:
    """Decode Kafka envelopes into analytics.events rows; drop records that can't be stored.

    Timestamps are emitted as epoch milliseconds (event_time_ms, received_at_ms) so the
    sink doesn't depend on the Python worker's local time zone.
    """
    value = F.col("value").cast("string")
    payload = F.from_json(value, ENVELOPE_SCHEMA).getField("payload")
    events = kafka_df.select(
        F.col("topic").alias("source_topic"),
        payload.getField("eventId").alias("event_id"),
        payload.getField("eventName").alias("event_name"),
        _uuid_or_null(payload.getField("campaignId")).alias("campaign_id"),
        _uuid_or_null(payload.getField("productId")).alias("product_id"),
        _uuid_or_null(payload.getField("userId")).alias("user_id"),
        payload.getField("tenantId").alias("tenant_id"),
        payload.getField("pageName").alias("page_name"),
        payload.getField("featureName").alias("feature_name"),
        _uuid_or_null(payload.getField("attributionId")).alias("attribution_id"),
        F.coalesce(F.get_json_object(value, "$.payload.properties"), F.lit("{}")).alias(
            "properties"
        ),
        F.unix_millis(payload.getField("timestamp")).alias("event_time_ms"),
        # Server time; the event time when the envelope has none.
        F.unix_millis(
            F.coalesce(payload.getField("receivedAt"), payload.getField("timestamp"))
        ).alias("received_at_ms"),
    )
    return (
        events.filter(
            F.col("event_id").rlike(UUID_PATTERN)
            & F.col("tenant_id").rlike(UUID_PATTERN)
            & (F.length(F.col("event_name")) > 0)
            & F.col("event_time_ms").isNotNull()
        )
        .withColumn("event_id", F.lower(F.col("event_id")))
        .withColumn("tenant_id", F.lower(F.col("tenant_id")))
    )


def prepare_batch(batch_df: DataFrame, partitions: int) -> DataFrame:
    """Group a micro-batch tenant-wise, then event-wise, in the table's sort order.

    Hash-partitioning on (tenant_id, event_name) puts each tenant/event slice in
    one Spark partition, so each ClickHouse insert covers few sort-key ranges and
    creates fewer, larger parts (less merging; avoids "too many parts"). Rows are
    sorted like analytics.events (tenant_id, event_name, campaign_id, event_time).

    Copies of one event share tenant_id and event_name, so they land in the same
    partition: the sink drops them there, without a second shuffle by event_id.

    event_id completes the sort, so a replayed batch produces identical inserts,
    which ClickHouse recognises and skips (see the events table settings).
    """
    return batch_df.repartition(partitions, "tenant_id", "event_name").sortWithinPartitions(
        "tenant_id", "event_name", "campaign_id", "event_time_ms", "event_id"
    )
