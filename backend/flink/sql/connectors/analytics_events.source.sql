-- Every analytics topic, including ones created later. The value is the
-- EventEnvelope from analytics-service (packages/contracts/src/analytics.ts),
-- read as text so a malformed record becomes NULLs instead of failing the job.
-- rowtime is the event's own time (payload.timestamp), for the session windows
-- (views/04_sessions.sql). The watermark trails the newest rowtime seen by an
-- hour: an event more than an hour older than that is too late for its session
-- (still stored and counted everywhere else). A malformed timestamp gets 1970,
-- since a rowtime can't be NULL; views/02_events.sql drops those records anyway.
CREATE TABLE kafka_events (
  `value` STRING,
  rowtime AS COALESCE(
    TRY_CAST(REPLACE(REPLACE(JSON_VALUE(`value`, '$.payload.timestamp'), 'T', ' '), 'Z', '') AS TIMESTAMP(3)),
    TIMESTAMP '1970-01-01 00:00:00'),
  WATERMARK FOR rowtime AS rowtime - INTERVAL '1' HOUR
) WITH (
  'connector' = 'kafka',
  'topic-pattern' = '^__TOPIC_PREFIX__analytics\..+\.v1$',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'properties.group.id' = '__KAFKA_GROUP_ID__',
  -- Topics created after the job started are picked up within this interval.
  'scan.topic-partition-discovery.interval' = '30 s',
  'scan.startup.mode' = '__KAFKA_STARTUP_MODE__',
  'format' = 'raw'
);
