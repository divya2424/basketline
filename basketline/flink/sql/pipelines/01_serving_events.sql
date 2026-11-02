INSERT INTO serving_events
SELECT event_id, event_name, campaign_id, product_id, user_id, user_type, client_type, tenant_id,
       page_name, feature_name, properties, event_time, received_at, event_type, seller_id
FROM events;
