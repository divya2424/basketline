-- One-off upgrade for a ClickHouse volume whose raw tables (events,
-- attributed_baskets) are partitioned by month and kept 7 days (init.sql only
-- runs on an empty volume). They become partitioned by day and kept 14 days,
-- with expired days dropped whole. A partition key can't be changed in place,
-- so each table is copied into the new layout and swapped in. The views that
-- write to or read from them are dropped first, so nothing is counted twice
-- during the copy; kafka.sql and init.sql create them again. ClickHouse's Kafka
-- consumers resume from their committed offsets, so nothing is lost. Stop the
-- Flink job first:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev --multiquery"
--   docker compose stop flink-streaming
--   $CH < infra/clickhouse/migrations/008_raw_daily_partitions.sql
--   $CH < infra/clickhouse/init.sql
--   $CH < infra/clickhouse/kafka.sql
--   docker compose up -d flink-streaming

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_events_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_baskets_mv;

CREATE TABLE analytics.events_daily
(
    event_id       UUID,
    event_name     LowCardinality(String),
    campaign_id    Nullable(UUID),
    product_id     Nullable(UUID),
    user_id        Nullable(UUID),
    tenant_id      UUID,
    page_name      Nullable(String),
    feature_name   Nullable(String),
    attribution_id Nullable(UUID),
    properties     String,
    event_time     DateTime64(3, 'UTC'),
    received_at    DateTime64(3, 'UTC'),
    ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_ingested_at ingested_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(event_time)
ORDER BY (tenant_id, event_name, campaign_id, event_time, event_id)
TTL toDateTime(event_time) + INTERVAL 14 DAY
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Every row as it is, ingested_at included, so the nightly check doesn't see them as new.
INSERT INTO analytics.events_daily SELECT * FROM analytics.events;
EXCHANGE TABLES analytics.events AND analytics.events_daily;
DROP TABLE analytics.events_daily;

CREATE TABLE analytics.attributed_baskets_daily
(
    basket_event_id UUID,
    click_event_id  UUID,
    tenant_id       UUID,
    campaign_id     UUID,
    product_id      Nullable(UUID),
    user_id         Nullable(UUID),
    event_time      DateTime64(3, 'UTC'),
    click_time      DateTime64(3, 'UTC'),
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_ingested_at ingested_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(event_time)
ORDER BY (tenant_id, campaign_id, event_time, basket_event_id, click_event_id)
TTL toDateTime(event_time) + INTERVAL 14 DAY
SETTINGS ttl_only_drop_parts = 1;

INSERT INTO analytics.attributed_baskets_daily SELECT * FROM analytics.attributed_baskets;
EXCHANGE TABLES analytics.attributed_baskets AND analytics.attributed_baskets_daily;
DROP TABLE analytics.attributed_baskets_daily;
