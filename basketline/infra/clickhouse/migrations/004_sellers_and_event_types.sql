-- One-off upgrade for a volume created before sellers and event types (01_tables.sql,
-- 03_kafka.sql): adds the columns to the existing tables, and drops the Kafka queue
-- tables and their views, which can't be altered in place. Their consumers resume
-- from their committed offsets, so nothing is lost. Then run 01_tables.sql (the new
-- sellers, products and deleted_users tables) and 03_kafka.sql again:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/migrations/004_sellers_and_event_types.sql
--   $CH < infra/clickhouse/01_tables.sql
--   $CH < infra/clickhouse/03_kafka.sql

ALTER TABLE analytics.events ADD COLUMN IF NOT EXISTS event_type LowCardinality(String) DEFAULT 'interaction' AFTER ingested_at;
ALTER TABLE analytics.events ADD COLUMN IF NOT EXISTS seller_id Nullable(UUID) AFTER event_type;
ALTER TABLE analytics.attributed_baskets ADD COLUMN IF NOT EXISTS seller_id Nullable(UUID) AFTER ingested_at;
ALTER TABLE analytics.sessions ADD COLUMN IF NOT EXISTS sellers Array(UUID) DEFAULT [] AFTER ingested_at;
ALTER TABLE analytics.campaigns ADD COLUMN IF NOT EXISTS seller_id Nullable(UUID) AFTER version;
ALTER TABLE analytics.campaigns ADD COLUMN IF NOT EXISTS issues Array(String) DEFAULT [] AFTER seller_id;

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP VIEW IF EXISTS analytics.sessions_queue_mv;
DROP TABLE IF EXISTS analytics.events_queue;
DROP TABLE IF EXISTS analytics.attributed_baskets_queue;
DROP TABLE IF EXISTS analytics.sessions_queue;
