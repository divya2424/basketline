-- Rows that can be counted: required IDs are UUIDs, an optional ID that isn't
-- becomes NULL. ingestion-service already validates events; this guards the sink.
CREATE TEMPORARY VIEW events AS
SELECT
  event_id,
  event_name,
  tenant_id,
  CASE WHEN REGEXP(store_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN store_id
       ELSE '00000000-0000-0000-0000-000000000000' END AS store_id,
  CASE WHEN REGEXP(campaign_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN campaign_id END AS campaign_id,
  CASE WHEN REGEXP(product_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN product_id END AS product_id,
  CASE WHEN REGEXP(user_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN user_id END AS user_id,
  CASE WHEN user_type IN ('visitor', 'registered') THEN user_type ELSE 'visitor' END AS user_type,
  CASE WHEN client_type IN ('web', 'mobile') THEN client_type ELSE 'web' END AS client_type,
  event_time,
  COALESCE(received_at, event_time) AS received_at
FROM parsed
WHERE REGEXP(event_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  AND REGEXP(tenant_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  AND event_time IS NOT NULL;
