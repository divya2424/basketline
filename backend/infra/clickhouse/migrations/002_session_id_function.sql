-- One-off upgrade for a volume created before session IDs came from the sessionId
-- function (00_functions.sql): creates it and recreates the view that uses it. A
-- view's query can't be changed in place; its Kafka consumer resumes from its
-- committed offsets, so nothing is lost. Then load 03_kafka.sql again:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery"
--   $CH < infra/clickhouse/migrations/002_session_id_function.sql
--   $CH < infra/clickhouse/00_functions.sql
--   $CH < infra/clickhouse/03_kafka.sql

DROP VIEW IF EXISTS analytics.sessions_queue_mv;
