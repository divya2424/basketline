-- One-off upgrade for a ClickHouse volume created before the Flink job replaced
-- Spark (init.sql and kafka.sql only run on an empty volume). It adds
-- attributed_baskets, replaces the daily job's views (they now count
-- attributed_baskets instead of joining raw events), then kafka.sql loads the
-- serving topics. Stored events are kept.
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev --multiquery"
--   docker compose stop spark-streaming && docker compose rm -f spark-streaming
--   $CH < infra/clickhouse/migrations/006_flink.sql
--   $CH < infra/clickhouse/init.sql        # creates the table and the two views again
--   $CH < infra/clickhouse/kafka.sql
--   docker compose up -d --build analytics-service flink-streaming
--
-- Flink starts from the earliest Kafka offsets, so the 7 days Kafka keeps are
-- loaded again (merged away as duplicates) and their baskets attributed. Baskets
-- older than that keep the totals already in campaign_daily_aggregates.

DROP VIEW IF EXISTS analytics.campaign_daily_aggregates_mv;
DROP VIEW IF EXISTS analytics.campaign_daily_changes_mv;
