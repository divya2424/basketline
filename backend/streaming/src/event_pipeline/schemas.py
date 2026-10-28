from pyspark.sql.types import StringType, StructField, StructType, TimestampType

# The Kafka message value: an EventEnvelope from analytics-service whose payload
# is an AnalyticsEventPayload (backend/packages/contracts/src/analytics.ts).
# `properties` is free-form JSON and is read separately as text.
PAYLOAD_SCHEMA = StructType(
    [
        StructField("eventId", StringType()),
        StructField("eventName", StringType()),
        StructField("campaignId", StringType()),
        StructField("productId", StringType()),
        StructField("userId", StringType()),
        StructField("tenantId", StringType()),
        StructField("pageName", StringType()),
        StructField("featureName", StringType()),
        StructField("attributionId", StringType()),
        StructField("timestamp", TimestampType()),
        StructField("receivedAt", TimestampType()),
    ]
)

ENVELOPE_SCHEMA = StructType([StructField("payload", PAYLOAD_SCHEMA)])

# Columns of analytics.events written by the sink (ingested_at has a default).
EVENT_COLUMNS = [
    "event_id",
    "event_name",
    "campaign_id",
    "product_id",
    "user_id",
    "tenant_id",
    "page_name",
    "feature_name",
    "attribution_id",
    "properties",
    "event_time",
    "received_at",
]
