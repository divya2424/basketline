-- The envelope's payload, as typed columns: only what the campaign metrics need.
-- ingestion-service writes IDs in lowercase (ingestion.service.ts) and timestamps
-- with toISOString() ("2026-10-28T12:00:00.000Z", always UTC), so both are used as they come.
CREATE TEMPORARY VIEW parsed AS
SELECT
  JSON_VALUE(`value`, '$.payload.eventId')    AS event_id,
  JSON_VALUE(`value`, '$.payload.eventName')  AS event_name,
  JSON_VALUE(`value`, '$.payload.tenantId')   AS tenant_id,
  -- The store it happened in; absent in events from before stores (the zero UUID then).
  JSON_VALUE(`value`, '$.payload.storeId')    AS store_id,
  JSON_VALUE(`value`, '$.payload.campaignId') AS campaign_id,
  JSON_VALUE(`value`, '$.payload.productId')  AS product_id,
  JSON_VALUE(`value`, '$.payload.userId')     AS user_id,
  JSON_VALUE(`value`, '$.payload.userType')   AS user_type,
  JSON_VALUE(`value`, '$.payload.clientType') AS client_type,
  TRY_CAST(REPLACE(REPLACE(JSON_VALUE(`value`, '$.payload.timestamp'), 'T', ' '), 'Z', '') AS TIMESTAMP(3)) AS event_time,
  TRY_CAST(REPLACE(REPLACE(JSON_VALUE(`value`, '$.payload.receivedAt'), 'T', ' '), 'Z', '') AS TIMESTAMP(3)) AS received_at
FROM kafka_events;
