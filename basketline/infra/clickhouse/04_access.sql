-- Tenant isolation in the database: the insights API (/ad) reads as
-- basketline_reader, which sees only the rows of the tenant each query names in
-- its SQL_tenant_id setting (insights-service sets it from the caller's token).
-- A query that forgets its tenant filter still can't return another tenant's
-- rows, and one that names no tenant gets none. readonly = 2: it can set query
-- settings (the tenant, time and memory limits) but never write.
--
-- ClickHouse schema, part 4. The services' own user (basketline) has no row
-- policy, so ingestion, the materialized views and the jobs see every tenant.
-- Rerun after adding a tenant table. Local password only: on AWS it comes from
-- Secrets Manager.

CREATE USER IF NOT EXISTS basketline_reader
    IDENTIFIED WITH sha256_password BY 'basketline_reader_dev'
    SETTINGS readonly = 2, SQL_tenant_id = '';

GRANT SELECT ON analytics.* TO basketline_reader;

CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON
    analytics.events, analytics.attributed_baskets, analytics.sessions,
    analytics.daily_campaign_aggregation, analytics.daily_campaign_customers_aggregation,
    analytics.daily_campaign_sessions_aggregation,
    analytics.campaigns, analytics.sellers, analytics.products, analytics.tenants,
    analytics.invalid_traffic_daily
    FOR SELECT USING tenant_id = toUUIDOrZero(getSetting('SQL_tenant_id'))
    TO basketline_reader;
