-- One-off upgrade for a volume created before the raw tables moved older days to
-- S3 (01_tables.sql): gives them the 'tiered' storage policy and the move. The
-- policy must exist first: restart ClickHouse with config/storage.xml mounted
-- (docker compose up -d clickhouse), then:
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline \
--     --password basketline_dev --multiquery < infra/clickhouse/migrations/001_tiered_storage.sql

ALTER TABLE analytics.events MODIFY SETTING storage_policy = 'tiered';
ALTER TABLE analytics.events MODIFY TTL toDateTime(event_time) + INTERVAL 7 DAY TO VOLUME 'cold', toDateTime(event_time) + INTERVAL 20 DAY;
ALTER TABLE analytics.attributed_baskets MODIFY SETTING storage_policy = 'tiered';
ALTER TABLE analytics.attributed_baskets MODIFY TTL toDateTime(event_time) + INTERVAL 7 DAY TO VOLUME 'cold', toDateTime(event_time) + INTERVAL 20 DAY;
ALTER TABLE analytics.sessions MODIFY SETTING storage_policy = 'tiered';
ALTER TABLE analytics.sessions MODIFY TTL toDateTime(session_start) + INTERVAL 7 DAY TO VOLUME 'cold', toDateTime(session_start) + INTERVAL 20 DAY;
