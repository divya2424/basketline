-- The Iceberg archive, written as events arrive (connectors/archive.catalog.sql),
-- so it scales with the job instead of a nightly copy out of ClickHouse. Each
-- checkpoint commits what was written since the last one, so a restart neither
-- loses nor repeats a commit. Copies of an event (redelivered, or replayed after a
-- checkpoint reset) are appended again; readers keep one per event_id, as the
-- history backfill does. A late event is appended to its own day.
--
-- Raw events come from the events view: the same rows as serving_events, without
-- reading the topic back. The two dropped columns stay NULL (export_archive.py).
INSERT INTO archive.`__ARCHIVE_NAMESPACE__`.events
SELECT event_id, event_name, campaign_id, product_id, user_id, tenant_id, page_name, feature_name,
       CAST(NULL AS STRING) AS attribution_id, properties,
       CAST(event_time AS TIMESTAMP_LTZ(6)), CAST(received_at AS TIMESTAMP_LTZ(6)), CAST(CURRENT_TIMESTAMP AS TIMESTAMP_LTZ(6)) AS ingested_at,
       CAST(NULL AS STRING) AS anonymous_id, client_type, user_type, event_type, seller_id
FROM events;

-- Credited basket additions are read back from their serving topic, since the
-- join's output can feed only one INSERT. Its own consumer group; from the start
-- of the topic when there is no checkpoint yet.
INSERT INTO archive.`__ARCHIVE_NAMESPACE__`.attributed_baskets
SELECT basket_event_id, click_event_id, tenant_id, campaign_id, product_id, user_id,
       CAST(event_time AS TIMESTAMP_LTZ(6)), CAST(click_time AS TIMESTAMP_LTZ(6)), CAST(CURRENT_TIMESTAMP AS TIMESTAMP_LTZ(6)) AS ingested_at,
       client_type, user_type, seller_id
FROM serving_attributed_baskets
  /*+ OPTIONS('properties.group.id' = '__KAFKA_GROUP_ID__-archive', 'scan.startup.mode' = 'earliest-offset') */;
