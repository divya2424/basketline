-- One-off upgrade for a ClickHouse volume created before tenants could be
-- deleted: adds analytics.deleted_tenants (init.sql) and makes the Kafka queue
-- views drop deleted tenants' rows (kafka.sql). A view's query can't be changed
-- in place, so they are dropped here and kafka.sql creates them again; the
-- Kafka consumers resume from their committed offsets, so nothing is lost:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/migrations/012_deleted_tenants.sql
--   $CH < infra/clickhouse/init.sql
--   $CH < infra/clickhouse/kafka.sql

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP VIEW IF EXISTS analytics.sessions_queue_mv;
