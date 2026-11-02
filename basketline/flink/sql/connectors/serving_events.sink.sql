-- Every ad impression and click, one JSON row per event, loaded into the
-- analytics.events staging table (infra/clickhouse/03_kafka.sql).
CREATE TABLE serving_events (
  event_id    STRING,
  event_name  STRING,
  tenant_id   STRING,
  store_id    STRING,
  campaign_id STRING,
  product_id  STRING,
  user_id     STRING,
  user_type   STRING,
  client_type STRING,
  event_time  TIMESTAMP(3),
  received_at TIMESTAMP(3)
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__serving.events.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'sink.delivery-guarantee' = 'at-least-once',
  'format' = 'json'
);
