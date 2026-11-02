-- The events the campaign metrics count (impressions and clicks, which always carry a campaign).
INSERT INTO serving_events
SELECT event_id, event_name, tenant_id, store_id, campaign_id, product_id, user_id, user_type, client_type, event_time, received_at
FROM events
WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL;
