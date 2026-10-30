-- The envelope's payload, as typed columns. analytics-service writes IDs in
-- lowercase (ingestion.service.ts) and timestamps with toISOString()
-- ("2026-10-28T12:00:00.000Z", always UTC), so both are used as they come.
CREATE TEMPORARY VIEW parsed AS
SELECT
  JSON_VALUE(`value`, '$.payload.eventId')              AS event_id,
  JSON_VALUE(`value`, '$.payload.eventName')            AS event_name,
  JSON_VALUE(`value`, '$.payload.campaignId')           AS campaign_id,
  JSON_VALUE(`value`, '$.payload.productId')            AS product_id,
  JSON_VALUE(`value`, '$.payload.userId')               AS user_id,
  JSON_VALUE(`value`, '$.payload.userType')             AS user_type,
  -- Only in events published before every visitor had a userId.
  JSON_VALUE(`value`, '$.payload.anonymousId')          AS anonymous_id,
  JSON_VALUE(`value`, '$.payload.clientType')           AS client_type,
  JSON_VALUE(`value`, '$.payload.tenantId')             AS tenant_id,
  JSON_VALUE(`value`, '$.payload.pageName')             AS page_name,
  JSON_VALUE(`value`, '$.payload.featureName')          AS feature_name,
  COALESCE(JSON_QUERY(`value`, '$.payload.properties'), '{}') AS properties,
  TRY_CAST(REPLACE(REPLACE(JSON_VALUE(`value`, '$.payload.timestamp'), 'T', ' '), 'Z', '') AS TIMESTAMP(3)) AS event_time,
  TRY_CAST(REPLACE(REPLACE(JSON_VALUE(`value`, '$.payload.receivedAt'), 'T', ' '), 'Z', '') AS TIMESTAMP(3)) AS received_at,
  -- The same time as event_time, as the source's time attribute: only the
  -- session windows use it, since a regular join can't take a time attribute.
  rowtime
FROM kafka_events;
