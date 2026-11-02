-- Every valid event, one JSON row per event, loaded into analytics.events (infra/clickhouse/03_kafka.sql).
CREATE TABLE serving_events (
  event_id       STRING,
  event_name     STRING,
  campaign_id    STRING,
  product_id     STRING,
  user_id        STRING,
  user_type      STRING,
  client_type    STRING,
  tenant_id      STRING,
  page_name      STRING,
  feature_name   STRING,
  properties     STRING,
  event_time     TIMESTAMP(3),
  received_at    TIMESTAMP(3),
  event_type     STRING,
  seller_id      STRING
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__serving.events.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'sink.delivery-guarantee' = 'at-least-once',
  'format' = 'json'
);
