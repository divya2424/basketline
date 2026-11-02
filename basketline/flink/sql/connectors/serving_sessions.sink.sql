-- Each user session, loaded into the analytics.sessions staging table
-- (infra/clickhouse/03_kafka.sql).
CREATE TABLE serving_sessions (
  tenant_id     STRING,
  user_id       STRING,
  user_type     STRING,
  session_start TIMESTAMP(3),
  session_end   TIMESTAMP(3),
  events        BIGINT,
  web           BOOLEAN,
  mobile        BOOLEAN,
  campaigns     ARRAY<STRING>,
  clicked       ARRAY<STRING>,
  added         ARRAY<STRING>
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__serving.sessions.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'sink.delivery-guarantee' = 'at-least-once',
  'format' = 'json'
);
