-- The interactions topic, and only it: identity events, campaigns, products and
-- the catalog go to the data lake (basketline/connect), not through Flink. The
-- value is the EventEnvelope from ingestion-service
-- (packages/contracts/src/analytics.ts), read as text so a malformed record
-- becomes NULLs instead of failing the job.
--
-- rowtime is the event's own time (payload.timestamp), for the session window
-- (pipelines/03_sessions.sql) only: the attribution join takes no time attribute
-- and drops nothing. The watermark trails the newest rowtime seen by 10 minutes:
-- an event older than that is too late for its session (it is still counted in
-- every other metric, and a history backfill puts it back). A malformed timestamp
-- gets 1970, since a rowtime can't be NULL; views/02_events.sql drops those records.
CREATE TABLE kafka_events (
  `value` STRING,
  rowtime AS COALESCE(
    TRY_CAST(REPLACE(REPLACE(JSON_VALUE(`value`, '$.payload.timestamp'), 'T', ' '), 'Z', '') AS TIMESTAMP(3)),
    TIMESTAMP '1970-01-01 00:00:00'),
  WATERMARK FOR rowtime AS rowtime - INTERVAL '10' MINUTE
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__retail.interactions.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'properties.group.id' = '__KAFKA_GROUP_ID__',
  'scan.startup.mode' = '__KAFKA_STARTUP_MODE__',
  'format' = 'raw'
);
