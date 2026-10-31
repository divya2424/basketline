-- One-off upgrade for a volume whose check ran nightly over closed days only: it
-- runs hourly and covers today (02_materialized_views.sql). A refreshable view's
-- schedule and query can't be changed in place, so it is dropped here, and
-- 02_materialized_views.sql creates it again:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/migrations/003_hourly_check.sql
--   $CH < infra/clickhouse/02_materialized_views.sql

DROP VIEW IF EXISTS analytics.daily_campaign_aggregation_check_mv;
