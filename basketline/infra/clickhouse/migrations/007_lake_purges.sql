-- One-off upgrade for a volume created before the data lake's shopper purges
-- (01_tables.sql): when tenant_purge deleted an erased shopper's rows from the lake.
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery \
--     < infra/clickhouse/migrations/007_lake_purges.sql

ALTER TABLE analytics.deleted_users ADD COLUMN IF NOT EXISTS lake_purged_at Nullable(DateTime64(3, 'UTC')) AFTER deleted_at;
