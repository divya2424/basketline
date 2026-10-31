-- Rows that can be stored: required IDs are UUIDs, an optional ID that isn't
-- becomes NULL. analytics-service already validates events; this guards the sink.
CREATE TEMPORARY VIEW events AS
SELECT
  event_id,
  event_name,
  CASE WHEN REGEXP(campaign_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN campaign_id END AS campaign_id,
  CASE WHEN REGEXP(product_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN product_id END AS product_id,
  -- Events published before every visitor had a userId carry its anonymousId instead.
  CASE WHEN REGEXP(user_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN user_id
       WHEN REGEXP(anonymous_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN anonymous_id END AS user_id,
  -- Those events had no userType: a userId meant a signed-in user.
  CASE WHEN user_type IN ('visitor', 'registered') THEN user_type
       WHEN REGEXP(user_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'registered'
       ELSE 'visitor' END AS user_type,
  -- Events published before the client type was recorded came from the web app.
  CASE WHEN client_type IN ('web', 'mobile') THEN client_type ELSE 'web' END AS client_type,
  tenant_id,
  page_name,
  feature_name,
  properties,
  event_time,
  COALESCE(received_at, event_time) AS received_at,
  CASE WHEN event_type IN ('interaction', 'identity') THEN event_type ELSE 'interaction' END AS event_type,
  CASE WHEN REGEXP(seller_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN seller_id END AS seller_id,
  rowtime
FROM parsed
WHERE REGEXP(event_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  AND REGEXP(tenant_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  AND CHAR_LENGTH(event_name) > 0
  -- Erasure is applied by analytics-service, never stored as an event.
  AND event_name <> 'user_deleted'
  AND event_time IS NOT NULL;
