-- One-off upgrade for a ClickHouse volume whose Kafka queue tables store what
-- they read every 7.5 s (kafka.sql only runs on an empty volume). They now
-- store it every 15 s. A Kafka table's settings can't be changed in place, so
-- the queue tables and their views are dropped and kafka.sql creates them
-- again. Their consumer groups keep their committed offsets, so they resume
-- where they stopped:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/migrations/009_kafka_flush_interval.sql
--   $CH < infra/clickhouse/kafka.sql

DROP VIEW IF EXISTS analytics.events_queue_mv;
DROP VIEW IF EXISTS analytics.attributed_baskets_queue_mv;
DROP TABLE IF EXISTS analytics.events_queue;
DROP TABLE IF EXISTS analytics.attributed_baskets_queue;
