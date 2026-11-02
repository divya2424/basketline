-- One-off upgrade for a volume created before stores and the aggregates-only
-- schema (01_tables.sql): ClickHouse keeps only the daily aggregates per tenant,
-- store and campaign, their 3-day staging and the erasure records. Campaigns,
-- products, sellers, tenants, sessions and invalid traffic go (the data lake has
-- the original events). Existing rows count under the zero store, as events sent
-- without a store do.
--
-- Part 1 (this file) stops the flows into the old tables and moves them aside;
-- 01_tables.sql creates the new ones; part 2 copies the old rows in (before the
-- materialized views exist, so nothing is counted twice) and drops what's left.
-- The Kafka consumers resume from their committed offsets. Stop the Flink job
-- first, and start the new one (it reads only retail.interactions.v1) after:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   cat infra/clickhouse/migrations/006_aggregates_only.sql infra/clickhouse/01_tables.sql \
--       infra/clickhouse/migrations/006_aggregates_only_copy.sql infra/clickhouse/02_materialized_views.sql \
--       infra/clickhouse/03_kafka.sql infra/clickhouse/04_access.sql | $CH

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP VIEW IF EXISTS analytics.sessions_queue_mv;
DROP TABLE IF EXISTS analytics.events_queue;
DROP TABLE IF EXISTS analytics.attributed_baskets_queue;
DROP TABLE IF EXISTS analytics.sessions_queue;

DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_events_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_baskets_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_check_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_customers_aggregation_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_customers_aggregation_baskets_mv;
DROP VIEW IF EXISTS analytics.daily_campaign_sessions_aggregation_mv;

-- 04_access.sql creates it again on the new tables.
DROP ROW POLICY IF EXISTS tenant_isolation ON
    analytics.events, analytics.attributed_baskets, analytics.sessions,
    analytics.daily_campaign_aggregation, analytics.daily_campaign_customers_aggregation,
    analytics.daily_campaign_sessions_aggregation, analytics.campaigns, analytics.products,
    analytics.sellers, analytics.tenants, analytics.invalid_traffic_daily;

RENAME TABLE analytics.events TO analytics.events_old,
             analytics.attributed_baskets TO analytics.attributed_baskets_old,
             analytics.daily_campaign_aggregation TO analytics.daily_campaign_aggregation_old,
             analytics.daily_campaign_customers_aggregation TO analytics.daily_campaign_customers_aggregation_old;

-- The Iceberg archive's purge times don't apply to the data lake: every deleted
-- tenant's lake folders are purged (again) by tenant_purge.
ALTER TABLE analytics.deleted_tenants DROP COLUMN IF EXISTS archive_purged_at;
ALTER TABLE analytics.deleted_tenants ADD COLUMN IF NOT EXISTS lake_purged_at Nullable(DateTime64(3, 'UTC')) AFTER deleted_at;
ALTER TABLE analytics.deleted_users DROP COLUMN IF EXISTS archive_purged_at;
