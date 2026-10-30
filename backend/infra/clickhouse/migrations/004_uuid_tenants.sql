-- One-off upgrade for a ClickHouse volume created before tenant IDs were UUIDs
-- (and before the two-step daily aggregates job). init.sql only runs on an empty
-- volume, so this drops every analytics table; init.sql then recreates them.
-- Stored events are not kept: their tenants were free-form strings with no UUID
-- to map to.
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev --multiquery"
--   docker compose stop flink-streaming
--   $CH < infra/clickhouse/migrations/004_uuid_tenants.sql
--   $CH < infra/clickhouse/init.sql
--   $CH < infra/clickhouse/kafka.sql
--   docker compose start flink-streaming
--
-- Kafka still holds the old events, with string tenants; the Flink job drops
-- them (tenant_id must be a UUID), so its checkpoint doesn't need resetting.
-- Campaign statuses are rebuilt from campaign.v1 by analytics-service; campaigns
-- last changed before Kafka's retention period need one more update (or a
-- replay, see the README) to be counted again.

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP TABLE IF EXISTS analytics.events_queue;
DROP TABLE IF EXISTS analytics.attributed_baskets_queue;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_events_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_baskets_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_check_mv;
DROP TABLE IF EXISTS analytics.daily_campaign_aggregation;
DROP VIEW IF EXISTS analytics.daily_campaign_customers_aggregation_mv;
DROP TABLE IF EXISTS analytics.daily_campaign_customers_aggregation;
DROP VIEW IF EXISTS analytics.campaign_daily_aggregates_mv;
DROP VIEW IF EXISTS analytics.campaign_daily_changes_mv;
DROP VIEW IF EXISTS analytics.campaign_hourly_aggregates_mv;
DROP VIEW IF EXISTS analytics.campaign_hourly_changes_mv;
DROP TABLE IF EXISTS analytics.campaign_daily_aggregates;
DROP TABLE IF EXISTS analytics.campaign_daily_changes;
DROP TABLE IF EXISTS analytics.campaign_hourly_aggregates;
DROP TABLE IF EXISTS analytics.campaign_hourly_changes;
DROP TABLE IF EXISTS analytics.campaigns;
DROP TABLE IF EXISTS analytics.attributed_baskets;
DROP TABLE IF EXISTS analytics.events;
