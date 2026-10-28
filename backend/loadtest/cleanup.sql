-- Removes every load-test event from ClickHouse (they stay in Kafka until retention).
DELETE FROM analytics.events WHERE tenant_id = toUUID('0ad7e570-0000-4000-8000-000000000001');
-- The daily totals the hourly job saved for the load-test tenant.
DELETE FROM analytics.campaign_daily_aggregates WHERE tenant_id = toUUID('0ad7e570-0000-4000-8000-000000000001');
