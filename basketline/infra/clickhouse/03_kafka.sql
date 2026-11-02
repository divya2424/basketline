-- Loads the Flink job's serving topics (basketline/flink/sql/) into the staging
-- tables analytics.events and analytics.attributed_baskets: a Kafka engine table
-- reads each topic, and a materialized view inserts what it reads.
--
-- ClickHouse schema, part 3 of 4. Kept apart: the tests load 01_tables.sql and
-- 02_materialized_views.sql into throwaway databases, which must not consume these topics.
--
-- Delivery is at least once (a restart may read a few messages again); the
-- staging tables merge copies away and every count uses uniqExact, so they count once.
--
-- kafka_flush_interval_ms: what has been read is stored at least every 15 s, in
-- fewer, larger inserts than the 7.5 s default (fewer parts, less merging). Data
-- reaches the dashboards within a minute, so the extra seconds cost nothing.

CREATE TABLE IF NOT EXISTS analytics.events_queue
(
    event_id    UUID,
    event_name  String,
    tenant_id   UUID,
    store_id    UUID,
    campaign_id UUID,
    product_id  Nullable(UUID),
    user_id     Nullable(UUID),
    user_type   LowCardinality(String),
    client_type LowCardinality(String),
    event_time  DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC')
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:19092',
         kafka_topic_list = 'serving.events.v1',
         kafka_group_name = 'clickhouse-events',
         kafka_format = 'JSONEachRow',
         kafka_flush_interval_ms = 15000;

-- A deleted tenant's or shopper's rows are dropped (analytics.deleted_tenants,
-- analytics.deleted_users), in case Kafka still has them.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.events_queue_mv TO analytics.events
AS SELECT * FROM analytics.events_queue
WHERE tenant_id NOT IN (SELECT tenant_id FROM analytics.deleted_tenants)
  AND (tenant_id, user_id) NOT IN (SELECT tenant_id, user_id FROM analytics.deleted_users);

CREATE TABLE IF NOT EXISTS analytics.attributed_baskets_queue
(
    basket_event_id UUID,
    click_event_id  UUID,
    tenant_id       UUID,
    store_id        UUID,
    campaign_id     UUID,
    product_id      Nullable(UUID),
    user_id         Nullable(UUID),
    user_type       LowCardinality(String),
    client_type     LowCardinality(String),
    event_time      DateTime64(3, 'UTC'),
    click_time      DateTime64(3, 'UTC')
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:19092',
         kafka_topic_list = 'serving.attributed_baskets.v1',
         kafka_group_name = 'clickhouse-attributed-baskets',
         kafka_format = 'JSONEachRow',
         kafka_flush_interval_ms = 15000;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.attributed_baskets_queue_mv TO analytics.attributed_baskets
AS SELECT * FROM analytics.attributed_baskets_queue
WHERE tenant_id NOT IN (SELECT tenant_id FROM analytics.deleted_tenants)
  AND (tenant_id, user_id) NOT IN (SELECT tenant_id, user_id FROM analytics.deleted_users);
