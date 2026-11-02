-- Removes every load-test event from ClickHouse (they stay in Kafka until retention).
DELETE FROM analytics.events WHERE tenant_id = toUUID('0ad7e570-0000-4000-8000-000000000001');
-- The load-test tenant's daily totals and unique customers.
DELETE FROM analytics.daily_campaign_aggregation WHERE tenant_id = toUUID('0ad7e570-0000-4000-8000-000000000001');
DELETE FROM analytics.daily_campaign_customers_aggregation WHERE tenant_id = toUUID('0ad7e570-0000-4000-8000-000000000001');
