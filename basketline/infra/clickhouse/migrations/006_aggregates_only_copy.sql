-- Part 2 of 006_aggregates_only.sql: run after 01_tables.sql, before
-- 02_materialized_views.sql (see part 1).

INSERT INTO analytics.daily_campaign_aggregation
SELECT day, tenant_id, toUUID('00000000-0000-0000-0000-000000000000') AS store_id, campaign_id,
       total_impressions, total_web_impressions, total_mobile_impressions,
       total_clicks, total_web_clicks, total_mobile_clicks,
       total_click_to_basket, total_web_click_to_basket, total_mobile_click_to_basket
FROM analytics.daily_campaign_aggregation_old;

INSERT INTO analytics.daily_campaign_customers_aggregation
SELECT day, tenant_id, toUUID('00000000-0000-0000-0000-000000000000') AS store_id, campaign_id,
       has_visited, has_visited_in_web, has_visited_in_mobile, has_visited_registered, has_visited_visitor,
       customers_impressions, customers_web_impressions, customers_mobile_impressions,
       customers_registered_impressions, customers_visitor_impressions,
       customers_clicks, customers_web_clicks, customers_mobile_clicks,
       customers_registered_clicks, customers_visitor_clicks,
       customers_click_to_basket, customers_web_click_to_basket, customers_mobile_click_to_basket,
       customers_registered_click_to_basket, customers_visitor_click_to_basket
FROM analytics.daily_campaign_customers_aggregation_old;

-- The days the staging TTL still keeps, whole, with their ingest times: the hourly
-- check recounts a day from staging, so staging must hold all of it.
INSERT INTO analytics.events
    (event_id, event_name, tenant_id, store_id, campaign_id, product_id, user_id, user_type, client_type, event_time, received_at, ingested_at)
SELECT event_id, event_name, tenant_id, toUUID('00000000-0000-0000-0000-000000000000'), assumeNotNull(campaign_id),
       product_id, user_id, user_type, client_type, event_time, received_at, ingested_at
FROM analytics.events_old
WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL
  AND event_time >= toStartOfDay(now64(3, 'UTC')) - INTERVAL 3 DAY;

INSERT INTO analytics.attributed_baskets
    (basket_event_id, click_event_id, tenant_id, store_id, campaign_id, product_id, user_id, user_type, client_type, event_time, click_time, ingested_at)
SELECT basket_event_id, click_event_id, tenant_id, toUUID('00000000-0000-0000-0000-000000000000'), campaign_id,
       product_id, user_id, user_type, client_type, event_time, click_time, ingested_at
FROM analytics.attributed_baskets_old
WHERE event_time >= toStartOfDay(now64(3, 'UTC')) - INTERVAL 3 DAY;

DROP TABLE IF EXISTS analytics.events_old;
DROP TABLE IF EXISTS analytics.attributed_baskets_old;
DROP TABLE IF EXISTS analytics.daily_campaign_aggregation_old;
DROP TABLE IF EXISTS analytics.daily_campaign_customers_aggregation_old;
DROP TABLE IF EXISTS analytics.daily_campaign_sessions_aggregation;
DROP TABLE IF EXISTS analytics.sessions;
DROP TABLE IF EXISTS analytics.campaigns;
DROP TABLE IF EXISTS analytics.products;
DROP TABLE IF EXISTS analytics.sellers;
DROP TABLE IF EXISTS analytics.tenants;
DROP TABLE IF EXISTS analytics.invalid_traffic_daily;
DROP TABLE IF EXISTS analytics.backfill_runs;
DROP FUNCTION IF EXISTS sessionId;
