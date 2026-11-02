-- One-off upgrade for a volume created before campaign titles (01_tables.sql): the
-- dashboard lists a tenant's campaigns from analytics.campaigns. Campaigns sent
-- before this have no title until the retailer sends them again (the campaign
-- service's `cli.ts republish`).
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery \
--     < infra/clickhouse/migrations/005_campaign_titles.sql

ALTER TABLE analytics.campaigns ADD COLUMN IF NOT EXISTS title String DEFAULT '' AFTER issues;
