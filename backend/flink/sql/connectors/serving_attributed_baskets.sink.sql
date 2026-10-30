-- Each basket addition credited to a click, loaded into analytics.attributed_baskets (infra/clickhouse/kafka.sql).
CREATE TABLE serving_attributed_baskets (
  basket_event_id STRING,
  click_event_id  STRING,
  tenant_id       STRING,
  campaign_id     STRING,
  product_id      STRING,
  user_id         STRING,
  user_type       STRING,
  client_type     STRING,
  event_time      TIMESTAMP(3),
  click_time      TIMESTAMP(3)
) WITH (
  'connector' = 'kafka',
  'topic' = '__TOPIC_PREFIX__serving.attributed_baskets.v1',
  'properties.bootstrap.servers' = '__KAFKA_BOOTSTRAP_SERVERS__',
  'sink.delivery-guarantee' = 'at-least-once',
  'format' = 'json'
);
