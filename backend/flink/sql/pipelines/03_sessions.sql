-- User sessions: a user's events (per tenant) with no gap of 6 hours or more
-- between them, an event-time session window partitioned by (tenant_id, user_id),
-- so each user's events meet on one task (the SQL form of
-- keyBy(tenantId, userId)). A session is emitted once, when the watermark passes
-- its last event + 6 hours (about 7 hours after it, with the source's 1-hour
-- watermark delay); an event later than the watermark is left out of sessions.
-- Attribution doesn't depend on sessions (02_attributed_baskets.sql).
-- Here and not in a view: Flink fails to expand a view holding a partitioned
-- session window.
INSERT INTO serving_sessions
SELECT
  tenant_id,
  user_id,
  CASE WHEN SUM(CASE WHEN user_type = 'registered' THEN 1 ELSE 0 END) > 0 THEN 'registered' ELSE 'visitor' END AS user_type,
  MIN(event_time) AS session_start,
  MAX(event_time) AS last_event_time,
  CAST(COUNT(*) AS BIGINT) AS events,
  SUM(CASE WHEN event_name = 'impression' THEN 1 ELSE 0 END) AS impressions,
  SUM(CASE WHEN event_name = 'click' THEN 1 ELSE 0 END) AS clicks,
  SUM(CASE WHEN event_name = 'add_to_cart' THEN 1 ELSE 0 END) AS add_to_carts,
  SUM(CASE WHEN client_type = 'web' THEN 1 ELSE 0 END) > 0 AS web,
  SUM(CASE WHEN client_type = 'mobile' THEN 1 ELSE 0 END) > 0 AS mobile,
  -- The campaigns it saw or clicked, the clicks' "campaign_id:product_id", and the
  -- products added to the cart: ClickHouse counts a session as converted for a
  -- campaign when it added a product it clicked there.
  ARRAY_AGG(DISTINCT CASE WHEN event_name IN ('impression', 'click') THEN campaign_id END IGNORE NULLS) AS campaigns,
  ARRAY_AGG(DISTINCT CASE WHEN event_name = 'click' THEN campaign_id || ':' || product_id END IGNORE NULLS) AS clicked,
  ARRAY_AGG(DISTINCT CASE WHEN event_name = 'add_to_cart' THEN product_id END IGNORE NULLS) AS added,
  -- The sellers of the products it touched.
  ARRAY_AGG(DISTINCT seller_id IGNORE NULLS) AS sellers
FROM TABLE(SESSION(TABLE session_events PARTITION BY (tenant_id, user_id), DESCRIPTOR(rowtime), INTERVAL '6' HOUR))
GROUP BY window_start, window_end, tenant_id, user_id;
