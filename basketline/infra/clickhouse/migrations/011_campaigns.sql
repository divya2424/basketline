-- One-off upgrade: the tenants' campaigns, for ingestion-service's check that an
-- impression or click is for one of the tenant's active campaigns. New objects
-- only, so the schema files create them:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/01_tables.sql
--   $CH < infra/clickhouse/03_kafka.sql
SELECT 1;
