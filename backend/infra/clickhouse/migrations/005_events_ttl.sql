-- One-off upgrade for a ClickHouse volume created before raw events expired
-- (init.sql only runs on an empty volume): delete events 7 days after they
-- happened, as init.sql now does. Events already older are deleted right away.
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline \
--     --password basketline_dev --multiquery < infra/clickhouse/migrations/005_events_ttl.sql

ALTER TABLE analytics.events MODIFY TTL toDateTime(event_time) + INTERVAL 7 DAY;
