-- Click → basket attribution, done here, not by the client: each basket addition
-- (add_to_cart) is matched with every click by the same user, on the same
-- product, of the same tenant, in the 7 days before it. One row per (basket,
-- candidate click); ClickHouse credits the latest one (last click,
-- infra/clickhouse/02_materialized_views.sql), since a click that arrives late
-- would otherwise have to retract a match already written.
--
-- The equality columns (tenant_id, user_id, product_id) are the join's key: Flink
-- hashes both sides on them, so a user's clicks and basket additions of a
-- product meet on one task, and each key holds only that user's clicks on that
-- product (the SQL form of keyBy(tenantId, userId, productId)). A person keeps
-- their UUID when they register, so a click made as a visitor matches a basket
-- addition after signing in.
--
-- A regular join, not an event-time window: each side waits in state for the
-- other, so a basket that arrives before its click, or a click that arrives late,
-- still matches. A click is kept 13 days after it arrives: analytics-service
-- accepts events up to 5 days old, plus the 7-day window, plus a day because the
-- TTL runs on the wall clock, so time the job is down or behind uses it up. A
-- basket addition is kept 6 days: it only waits for a click from before it that
-- arrives late, at most 5 days after it happened, plus the same day. The
-- analytics topics keep 14 days, so a replay rebuilds all of it. The basket
-- addition's client type is the one it is counted under.
INSERT INTO serving_attributed_baskets
SELECT /*+ STATE_TTL('b' = '6d', 'c' = '13d') */
  b.event_id, c.event_id, b.tenant_id, c.campaign_id, b.product_id, b.user_id, b.user_type, b.client_type, b.event_time, c.event_time
FROM baskets AS b
JOIN clicks AS c
  ON b.tenant_id = c.tenant_id
 AND b.user_id = c.user_id
 AND b.product_id = c.product_id
 AND b.event_time >= c.event_time
 AND b.event_time <= c.event_time + INTERVAL '7' DAY;
