-- One-off upgrade for a ClickHouse volume whose daily tables
-- (daily_campaign_aggregation, daily_campaign_customers_aggregation,
-- daily_campaign_sessions_aggregation) are partitioned by year (init.sql only
-- runs on an empty volume). They become partitioned by month, so the history
-- backfill can swap a closed month without touching the current one; rows stay
-- one per tenant, campaign and day. A partition key can't be changed in place,
-- so each table is copied into the new layout and swapped in. The views that
-- write to them, and the Kafka queue views that feed those, are dropped first,
-- so nothing is counted twice or missed during the copy; init.sql and kafka.sql
-- create them again, and ClickHouse's Kafka consumers resume from their
-- committed offsets:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev --multiquery"
--   $CH < infra/clickhouse/migrations/010_monthly_daily_partitions.sql
--   $CH < infra/clickhouse/init.sql
--   $CH < infra/clickhouse/kafka.sql

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP VIEW IF EXISTS analytics.sessions_queue_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_events_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_baskets_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_check_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_customers_aggregation_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_customers_aggregation_baskets_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_sessions_aggregation_mv;

CREATE TABLE analytics.daily_campaign_aggregation_monthly AS analytics.daily_campaign_aggregation
ENGINE = SummingMergeTree PARTITION BY toYYYYMM(day) ORDER BY (tenant_id, campaign_id, day);
INSERT INTO analytics.daily_campaign_aggregation_monthly SELECT * FROM analytics.daily_campaign_aggregation;
EXCHANGE TABLES analytics.daily_campaign_aggregation AND analytics.daily_campaign_aggregation_monthly;
DROP TABLE analytics.daily_campaign_aggregation_monthly;

CREATE TABLE analytics.daily_campaign_customers_aggregation_monthly AS analytics.daily_campaign_customers_aggregation
ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(day) ORDER BY (tenant_id, campaign_id, day);
INSERT INTO analytics.daily_campaign_customers_aggregation_monthly SELECT * FROM analytics.daily_campaign_customers_aggregation;
EXCHANGE TABLES analytics.daily_campaign_customers_aggregation AND analytics.daily_campaign_customers_aggregation_monthly;
DROP TABLE analytics.daily_campaign_customers_aggregation_monthly;

CREATE TABLE analytics.daily_campaign_sessions_aggregation_monthly AS analytics.daily_campaign_sessions_aggregation
ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(day) ORDER BY (tenant_id, campaign_id, day);
INSERT INTO analytics.daily_campaign_sessions_aggregation_monthly SELECT * FROM analytics.daily_campaign_sessions_aggregation;
EXCHANGE TABLES analytics.daily_campaign_sessions_aggregation AND analytics.daily_campaign_sessions_aggregation_monthly;
DROP TABLE analytics.daily_campaign_sessions_aggregation_monthly;
