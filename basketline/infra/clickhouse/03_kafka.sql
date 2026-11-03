-- Loads the Flink job's serving topics (basketline/flink/sql/) into the staging
-- tables analytics.events, analytics.attributed_baskets and analytics.sessions, and
-- retail.campaign-products.v1 into analytics.campaign_products: a Kafka engine
-- table reads each topic, and a materialized view inserts what it reads.
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

CREATE TABLE IF NOT EXISTS analytics.sessions_queue
(
    tenant_id     UUID,
    user_id       UUID,
    user_type     LowCardinality(String),
    session_start DateTime64(3, 'UTC'),
    session_end   DateTime64(3, 'UTC'),
    events        UInt32,
    web           Bool,
    mobile        Bool,
    campaigns     Array(String),
    clicked       Array(String),
    added         Array(UUID)
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:19092',
         kafka_topic_list = 'serving.sessions.v1',
         kafka_group_name = 'clickhouse-sessions',
         kafka_format = 'JSONEachRow',
         kafka_flush_interval_ms = 15000;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.sessions_queue_mv TO analytics.sessions
AS SELECT * FROM analytics.sessions_queue
WHERE tenant_id NOT IN (SELECT tenant_id FROM analytics.deleted_tenants)
  AND (tenant_id, user_id) NOT IN (SELECT tenant_id, user_id FROM analytics.deleted_users);

-- The products added to campaigns (retail.campaign-products.v1, written by
-- ingestion-service's retail API), to name them in the per-product results. The
-- topic is compacted, so a new consumer group reads every pair's latest state.
-- Its messages are event envelopes: read whole, the payload extracted.
CREATE TABLE IF NOT EXISTS analytics.campaign_products_queue
(
    message String
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:19092',
         kafka_topic_list = 'retail.campaign-products.v1',
         kafka_group_name = 'clickhouse-campaign-products',
         kafka_format = 'JSONAsString',
         kafka_flush_interval_ms = 15000;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.campaign_products_queue_mv TO analytics.campaign_products
AS SELECT
    toUUID(JSONExtractString(message, 'payload', 'tenantId')) AS tenant_id,
    toUUID(JSONExtractString(message, 'payload', 'campaignId')) AS campaign_id,
    toUUID(JSONExtractString(message, 'payload', 'productId')) AS product_id,
    toUUID(JSONExtractString(message, 'payload', 'storeId')) AS store_id,
    JSONExtractString(message, 'payload', 'productName') AS product_name,
    JSONExtract(message, 'payload', 'productPrice', 'Nullable(Float64)') AS product_price,
    JSONExtract(message, 'payload', 'category', 'Nullable(String)') AS category,
    parseDateTime64BestEffort(JSONExtractString(message, 'payload', 'updatedAt'), 3, 'UTC') AS updated_at
FROM analytics.campaign_products_queue
WHERE JSONExtractString(message, 'eventType') = 'campaign_product_added'
  AND tenant_id NOT IN (SELECT tenant_id FROM analytics.deleted_tenants);
