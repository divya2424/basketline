-- The interactions topic, and only it: identity events, campaigns, products and
-- the catalog go to the data lake (basketline/connect), not through Flink. The
-- value is the EventEnvelope from ingestion-service
-- (packages/contracts/src/analytics.ts), read as text so a malformed record
-- becomes NULLs instead of failing the job.
CREATE TABLE kafka_events (
  `value` STRING
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__retail.interactions.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'properties.group.id' = '__KAFKA_GROUP_ID__',
  'scan.startup.mode' = '__KAFKA_STARTUP_MODE__',
  'format' = 'raw'
);
