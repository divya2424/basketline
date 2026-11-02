-- User sessions: a user's interactions (per tenant) with no gap of 30 minutes or
-- more between them, an event-time session window partitioned by (tenant_id,
-- user_id), so each user's events meet on one task (the SQL form of
-- keyBy(tenantId, userId)) and its state is only that user's open session. A
-- session is written once, when the watermark passes its last event + 30
-- minutes (about 40 minutes after it, with the source's 10-minute delay); its
-- state is then dropped. A shopper keeps their visitor UUID when they sign in,
-- so browsing as a visitor and buying signed in is one session.
--
-- Per session, what the campaign metrics need (infra/clickhouse/02_materialized_views.sql):
-- the "store_id:campaign_id" of each campaign it saw or clicked, the
-- "campaign_id:product_id" of each click, and the products added to the cart: a
-- session converted for a campaign when it added a product it clicked there.
-- Attribution doesn't depend on sessions (02_attributed_baskets.sql).
-- Here and not in a view: Flink fails to expand a view holding a partitioned
-- session window.
INSERT INTO serving_sessions
SELECT
  tenant_id,
  user_id,
  CASE WHEN SUM(CASE WHEN user_type = 'registered' THEN 1 ELSE 0 END) > 0 THEN 'registered' ELSE 'visitor' END AS user_type,
  MIN(event_time) AS session_start,
  MAX(event_time) AS session_end,
  COUNT(*) AS events,
  SUM(CASE WHEN client_type = 'web' THEN 1 ELSE 0 END) > 0 AS web,
  SUM(CASE WHEN client_type = 'mobile' THEN 1 ELSE 0 END) > 0 AS mobile,
  ARRAY_AGG(DISTINCT CASE WHEN event_name IN ('impression', 'click') THEN store_id || ':' || campaign_id END IGNORE NULLS) AS campaigns,
  ARRAY_AGG(DISTINCT CASE WHEN event_name = 'click' THEN campaign_id || ':' || product_id END IGNORE NULLS) AS clicked,
  ARRAY_AGG(DISTINCT CASE WHEN event_name = 'add_to_cart' THEN product_id END IGNORE NULLS) AS added
FROM TABLE(SESSION(TABLE session_events PARTITION BY (tenant_id, user_id), DESCRIPTOR(rowtime), INTERVAL '30' MINUTE))
GROUP BY window_start, window_end, tenant_id, user_id;
