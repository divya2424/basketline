-- Each user session, loaded into analytics.sessions (infra/clickhouse/kafka.sql).
CREATE TABLE serving_sessions (
  tenant_id       STRING,
  user_id         STRING,
  user_type       STRING,
  session_start   TIMESTAMP(3),
  last_event_time TIMESTAMP(3),
  events          BIGINT,
  impressions     BIGINT,
  clicks          BIGINT,
  add_to_carts    BIGINT,
  web             BOOLEAN,
  mobile          BOOLEAN,
  campaigns       ARRAY<STRING>,
  clicked         ARRAY<STRING>,
  added           ARRAY<STRING>
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__serving.sessions.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'sink.delivery-guarantee' = 'at-least-once',
  'format' = 'json'
);
