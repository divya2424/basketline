-- Clicks that can be credited: on a campaign, for a product, by a known user.
CREATE TEMPORARY VIEW clicks AS
SELECT event_id, tenant_id, campaign_id, product_id, user_id, event_time
FROM events
WHERE event_name = 'click' AND campaign_id IS NOT NULL AND product_id IS NOT NULL AND user_id IS NOT NULL;

-- Basket additions: any add_to_cart of a product by a known user. Clients send
-- no link to a click; the attribution pipeline finds it.
CREATE TEMPORARY VIEW baskets AS
SELECT event_id, tenant_id, product_id, user_id, user_type, client_type, event_time
FROM events
WHERE event_name = 'add_to_cart' AND product_id IS NOT NULL AND user_id IS NOT NULL;
