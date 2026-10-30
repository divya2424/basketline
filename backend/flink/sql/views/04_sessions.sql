-- The events user sessions are made of (pipelines/03_sessions.sql): those of a
-- known user. Filtered here, before the session window, which can't filter its
-- own input.
CREATE TEMPORARY VIEW session_events AS
SELECT tenant_id, user_id, user_type, client_type, event_name, campaign_id, product_id, event_time, rowtime
FROM events
WHERE user_id IS NOT NULL;
