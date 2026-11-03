-- One-off upgrade for a volume created before per-product results: the daily
-- table of a campaign's results per product and its views, the campaign products'
-- names from retail.campaign-products.v1, and the row policy on both (01_tables.sql
-- to 04_access.sql). The daily table fills from now on; a history backfill
-- (airflow/jobs/backfill_daily.py --table daily_campaign_product_aggregation)
-- computes its past days from the data lake.
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery \
--     < infra/clickhouse/migrations/010_campaign_products.sql

CREATE TABLE IF NOT EXISTS analytics.daily_campaign_product_aggregation
(
    day             Date,
    tenant_id       UUID,
    store_id        UUID,
    campaign_id     UUID,
    product_id      UUID,
    impressions     Int64,
    clicks          Int64,
    click_to_basket Int64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, store_id, campaign_id, product_id, day);

CREATE TABLE IF NOT EXISTS analytics.campaign_products
(
    tenant_id     UUID,
    campaign_id   UUID,
    product_id    UUID,
    store_id      UUID,
    product_name  String,
    product_price Nullable(Float64),
    category      Nullable(String),
    updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, campaign_id, product_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_product_aggregation_events_mv
TO analytics.daily_campaign_product_aggregation
AS SELECT
    toDate(event_time) AS day,
    tenant_id,
    store_id,
    campaign_id,
    assumeNotNull(product_id) AS product_id,
    toInt64(uniqExactIf(event_id, event_name = 'impression')) AS impressions,
    toInt64(uniqExactIf(event_id, event_name = 'click')) AS clicks,
    toInt64(0) AS click_to_basket
-- Filtered in a subquery: in the outer WHERE, product_id would be the alias above.
FROM (SELECT * FROM analytics.events WHERE event_name IN ('impression', 'click') AND product_id IS NOT NULL)
GROUP BY day, tenant_id, store_id, campaign_id, product_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_product_aggregation_baskets_mv
TO analytics.daily_campaign_product_aggregation
AS SELECT
    toDate(basket_time) AS day,
    tenant_id,
    basket_store_id AS store_id,
    winning_campaign_id AS campaign_id,
    assumeNotNull(basket_product_id) AS product_id,
    toInt64(0) AS impressions,
    toInt64(0) AS clicks,
    toInt64(uniqExact(winning_click_id)) AS click_to_basket
FROM
(
    SELECT tenant_id, basket_event_id,
           argMax(campaign_id, (click_time, click_event_id)) AS winning_campaign_id,
           max((click_time, click_event_id)).2 AS winning_click_id,
           any(store_id) AS basket_store_id, any(product_id) AS basket_product_id, any(event_time) AS basket_time
    FROM analytics.attributed_baskets
    GROUP BY tenant_id, basket_event_id
)
WHERE basket_product_id IS NOT NULL
GROUP BY day, tenant_id, store_id, campaign_id, product_id;

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

-- The row policy, on the two new tables too.
DROP ROW POLICY IF EXISTS tenant_isolation ON
    analytics.events, analytics.attributed_baskets, analytics.sessions,
    analytics.daily_campaign_aggregation, analytics.daily_campaign_customers_aggregation,
    analytics.daily_campaign_sessions_aggregation;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON
    analytics.events, analytics.attributed_baskets, analytics.sessions,
    analytics.daily_campaign_aggregation, analytics.daily_campaign_customers_aggregation,
    analytics.daily_campaign_sessions_aggregation, analytics.daily_campaign_product_aggregation,
    analytics.campaign_products
    FOR SELECT USING tenant_id = toUUIDOrZero(getSetting('SQL_tenant_id'))
    TO basketline_reader;
