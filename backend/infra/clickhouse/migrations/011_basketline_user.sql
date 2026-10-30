-- One-off upgrade for a ClickHouse volume created before the platform was
-- renamed Basketline. The ClickHouse user is now basketline (the container
-- creates it from CLICKHOUSE_USER on every start), but the nightly check runs
-- as the user that created it (a refreshable view's DEFINER), which no longer
-- exists. It is dropped here; init.sql creates it again under basketline. No
-- data is touched:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/migrations/011_basketline_user.sql
--   $CH < infra/clickhouse/init.sql

DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_check_mv;
