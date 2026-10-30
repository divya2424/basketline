-- ClickHouse schema, part 2 of 3: the materialized views that fill the daily
-- tables (01_tables.sql, where each table's comment explains its counting rules)
-- from the raw tables as rows are stored, and the nightly check that corrects
-- closed days.

-- Live: impressions and clicks. uniqExact within each insert, so copies sent in
-- the same batch count once; copies in different batches are left to the check.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_aggregation_events_mv
TO analytics.daily_campaign_aggregation
AS SELECT
    toDate(event_time) AS day,
    tenant_id,
    assumeNotNull(campaign_id) AS campaign_id,
    toInt64(uniqExactIf(event_id, event_name = 'impression')) AS total_impressions,
    toInt64(uniqExactIf(event_id, event_name = 'impression' AND client_type = 'web')) AS total_web_impressions,
    toInt64(uniqExactIf(event_id, event_name = 'impression' AND client_type = 'mobile')) AS total_mobile_impressions,
    toInt64(uniqExactIf(event_id, event_name = 'click')) AS total_clicks,
    toInt64(uniqExactIf(event_id, event_name = 'click' AND client_type = 'web')) AS total_web_clicks,
    toInt64(uniqExactIf(event_id, event_name = 'click' AND client_type = 'mobile')) AS total_mobile_clicks,
    toInt64(0) AS total_click_to_basket,
    toInt64(0) AS total_web_click_to_basket,
    toInt64(0) AS total_mobile_click_to_basket
FROM analytics.events
WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL
GROUP BY day, tenant_id, campaign_id;

-- Live: basket additions credited to their latest click, once per click and
-- product. The latest click among each insert's candidates: a basket whose
-- candidates arrive in different inserts (the user clicked the product in two
-- campaigns) counts for both until the nightly check.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_aggregation_baskets_mv
TO analytics.daily_campaign_aggregation
AS SELECT
    toDate(basket_time) AS day,
    tenant_id,
    winning_campaign_id AS campaign_id,
    toInt64(0) AS total_impressions,
    toInt64(0) AS total_web_impressions,
    toInt64(0) AS total_mobile_impressions,
    toInt64(0) AS total_clicks,
    toInt64(0) AS total_web_clicks,
    toInt64(0) AS total_mobile_clicks,
    toInt64(uniqExact(winning_click_id, basket_product_id)) AS total_click_to_basket,
    toInt64(uniqExactIf(winning_click_id, basket_product_id, basket_client_type = 'web')) AS total_web_click_to_basket,
    toInt64(uniqExactIf(winning_click_id, basket_product_id, basket_client_type = 'mobile')) AS total_mobile_click_to_basket
FROM
(
    SELECT tenant_id, basket_event_id,
           argMax(campaign_id, (click_time, click_event_id)) AS winning_campaign_id,
           max((click_time, click_event_id)).2 AS winning_click_id,
           any(product_id) AS basket_product_id, any(client_type) AS basket_client_type, any(event_time) AS basket_time
    FROM analytics.attributed_baskets
    GROUP BY tenant_id, basket_event_id
)
GROUP BY day, tenant_id, campaign_id;

-- Check (every night at 00:30 UTC): for each closed day (before today), tenant
-- and campaign that got rows in the last 26 hours, the exact counts from raw
-- events minus what the table holds, appended as one correcting row. A day that
-- is already right gets nothing. The 2 hours of overlap with the previous run
-- cover rows stored while it was reading. Each day is recounted about once, the
-- night after it ends, and again only if late events arrive for it. Raw events
-- are kept longer than the 5 days events may arrive late, so a changed day still
-- has all of its raw events. If a night's run fails, those days keep their live
-- counts, which are off only by the rare duplicates. Basket additions are
-- recounted with their latest click; a basket that got a new candidate marks the
-- days and campaigns of all its candidates as changed, so a campaign that lost
-- the credit is corrected down (to 0 if it has nothing else that day).
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_aggregation_check_mv
REFRESH EVERY 1 DAY OFFSET 30 MINUTE APPEND
TO analytics.daily_campaign_aggregation
AS WITH changed AS
(
    SELECT toDate(event_time) AS day, tenant_id, assumeNotNull(campaign_id) AS campaign_id
    FROM analytics.events
    WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL
      AND ingested_at >= now64(3, 'UTC') - INTERVAL 26 HOUR AND event_time < toStartOfDay(now64(3, 'UTC'))

    UNION DISTINCT

    SELECT toDate(event_time), tenant_id, campaign_id
    FROM analytics.attributed_baskets
    WHERE (tenant_id, basket_event_id) IN
    (
        SELECT tenant_id, basket_event_id
        FROM analytics.attributed_baskets
        WHERE ingested_at >= now64(3, 'UTC') - INTERVAL 26 HOUR AND event_time < toStartOfDay(now64(3, 'UTC'))
    )
),
exact AS
(
    SELECT day, tenant_id, campaign_id,
           sum(i) AS i, sum(iw) AS iw, sum(im) AS im, sum(c) AS c, sum(cw) AS cw, sum(cm) AS cm, sum(b) AS b, sum(bw) AS bw, sum(bm) AS bm
    FROM
    (
        SELECT toDate(event_time) AS day, tenant_id, assumeNotNull(campaign_id) AS campaign_id,
               toInt64(uniqExactIf(event_id, event_name = 'impression')) AS i,
               toInt64(uniqExactIf(event_id, event_name = 'impression' AND client_type = 'web')) AS iw,
               toInt64(uniqExactIf(event_id, event_name = 'impression' AND client_type = 'mobile')) AS im,
               toInt64(uniqExactIf(event_id, event_name = 'click')) AS c,
               toInt64(uniqExactIf(event_id, event_name = 'click' AND client_type = 'web')) AS cw,
               toInt64(uniqExactIf(event_id, event_name = 'click' AND client_type = 'mobile')) AS cm,
               toInt64(0) AS b, toInt64(0) AS bw, toInt64(0) AS bm
        FROM analytics.events
        WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL
          AND event_time >= (SELECT min(day) FROM changed)
          AND (toDate(event_time), tenant_id, assumeNotNull(campaign_id)) IN (SELECT day, tenant_id, campaign_id FROM changed)
        GROUP BY day, tenant_id, campaign_id

        UNION ALL

        SELECT toDate(basket_time) AS day, tenant_id, winning_campaign_id AS campaign_id,
               toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0),
               toInt64(uniqExact(winning_click_id, basket_product_id)),
               toInt64(uniqExactIf(winning_click_id, basket_product_id, basket_client_type = 'web')),
               toInt64(uniqExactIf(winning_click_id, basket_product_id, basket_client_type = 'mobile'))
        FROM
        (
            -- Each basket addition with its latest click, over all of its candidates.
            SELECT tenant_id, basket_event_id,
                   argMax(campaign_id, (click_time, click_event_id)) AS winning_campaign_id,
                   max((click_time, click_event_id)).2 AS winning_click_id,
                   any(product_id) AS basket_product_id, any(client_type) AS basket_client_type, any(event_time) AS basket_time
            FROM analytics.attributed_baskets
            WHERE event_time >= (SELECT min(day) FROM changed)
              AND (toDate(event_time), tenant_id) IN (SELECT day, tenant_id FROM changed)
            GROUP BY tenant_id, basket_event_id
        )
        WHERE (toDate(basket_time), tenant_id, winning_campaign_id) IN (SELECT day, tenant_id, campaign_id FROM changed)
        GROUP BY day, tenant_id, campaign_id

        UNION ALL

        -- Every changed key, so one whose counts dropped to nothing is corrected too.
        SELECT day, tenant_id, campaign_id, toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0), toInt64(0)
        FROM changed
    )
    GROUP BY day, tenant_id, campaign_id
),
stored AS
(
    SELECT day, tenant_id, campaign_id,
           sum(total_impressions) AS i, sum(total_web_impressions) AS iw, sum(total_mobile_impressions) AS im,
           sum(total_clicks) AS c, sum(total_web_clicks) AS cw, sum(total_mobile_clicks) AS cm,
           sum(total_click_to_basket) AS b, sum(total_web_click_to_basket) AS bw, sum(total_mobile_click_to_basket) AS bm
    FROM analytics.daily_campaign_aggregation
    WHERE (day, tenant_id, campaign_id) IN (SELECT day, tenant_id, campaign_id FROM changed)
    GROUP BY day, tenant_id, campaign_id
)
SELECT *
FROM
(
    SELECT
        exact.day AS day,
        exact.tenant_id AS tenant_id,
        exact.campaign_id AS campaign_id,
        exact.i - stored.i AS total_impressions,
        exact.iw - stored.iw AS total_web_impressions,
        exact.im - stored.im AS total_mobile_impressions,
        exact.c - stored.c AS total_clicks,
        exact.cw - stored.cw AS total_web_clicks,
        exact.cm - stored.cm AS total_mobile_clicks,
        exact.b - stored.b AS total_click_to_basket,
        exact.bw - stored.bw AS total_web_click_to_basket,
        exact.bm - stored.bm AS total_mobile_click_to_basket
    FROM exact
    LEFT JOIN stored ON exact.day = stored.day AND exact.tenant_id = stored.tenant_id AND exact.campaign_id = stored.campaign_id
)
WHERE total_impressions != 0 OR total_web_impressions != 0 OR total_mobile_impressions != 0
   OR total_clicks != 0 OR total_web_clicks != 0 OR total_mobile_clicks != 0
   OR total_click_to_basket != 0 OR total_web_click_to_basket != 0 OR total_mobile_click_to_basket != 0;

-- Live: who saw or clicked the campaign.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_customers_aggregation_mv
TO analytics.daily_campaign_customers_aggregation
AS SELECT
    toDate(event_time) AS day,
    tenant_id,
    assumeNotNull(campaign_id) AS campaign_id,
    uniqCombined64State(assumeNotNull(user_id)) AS has_visited,
    uniqCombined64StateIf(assumeNotNull(user_id), client_type = 'web') AS has_visited_in_web,
    uniqCombined64StateIf(assumeNotNull(user_id), client_type = 'mobile') AS has_visited_in_mobile,
    uniqCombined64StateIf(assumeNotNull(user_id), user_type = 'registered') AS has_visited_registered,
    uniqCombined64StateIf(assumeNotNull(user_id), user_type = 'visitor') AS has_visited_visitor,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'impression') AS customers_impressions,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'impression' AND client_type = 'web') AS customers_web_impressions,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'impression' AND client_type = 'mobile') AS customers_mobile_impressions,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'impression' AND user_type = 'registered') AS customers_registered_impressions,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'impression' AND user_type = 'visitor') AS customers_visitor_impressions,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'click') AS customers_clicks,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'click' AND client_type = 'web') AS customers_web_clicks,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'click' AND client_type = 'mobile') AS customers_mobile_clicks,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'click' AND user_type = 'registered') AS customers_registered_clicks,
    uniqCombined64StateIf(assumeNotNull(user_id), event_name = 'click' AND user_type = 'visitor') AS customers_visitor_clicks
FROM analytics.events
WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL AND user_id IS NOT NULL
GROUP BY day, tenant_id, campaign_id;

-- Live: who added a product to the cart after clicking, on the day of the basket
-- addition, for the campaign of its latest click among each insert's candidates.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_customers_aggregation_baskets_mv
TO analytics.daily_campaign_customers_aggregation
AS SELECT
    toDate(basket_time) AS day,
    tenant_id,
    winning_campaign_id AS campaign_id,
    uniqCombined64State(basket_user_id) AS customers_click_to_basket,
    uniqCombined64StateIf(basket_user_id, basket_client_type = 'web') AS customers_web_click_to_basket,
    uniqCombined64StateIf(basket_user_id, basket_client_type = 'mobile') AS customers_mobile_click_to_basket,
    uniqCombined64StateIf(basket_user_id, basket_user_type = 'registered') AS customers_registered_click_to_basket,
    uniqCombined64StateIf(basket_user_id, basket_user_type = 'visitor') AS customers_visitor_click_to_basket
FROM
(
    SELECT tenant_id, basket_event_id,
           argMax(campaign_id, (click_time, click_event_id)) AS winning_campaign_id,
           assumeNotNull(any(user_id)) AS basket_user_id, any(user_type) AS basket_user_type,
           any(client_type) AS basket_client_type, any(event_time) AS basket_time
    FROM analytics.attributed_baskets
    WHERE user_id IS NOT NULL
    GROUP BY tenant_id, basket_event_id
)
GROUP BY day, tenant_id, campaign_id;

-- Live: each session's campaigns, as it is stored.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_sessions_aggregation_mv
TO analytics.daily_campaign_sessions_aggregation
AS SELECT
    toDate(session_start) AS day,
    tenant_id,
    campaign_id,
    uniqCombined64State(session_id) AS total_sessions,
    uniqCombined64StateIf(session_id, arrayExists(pair -> splitByChar(':', pair)[1] = toString(campaign_id)
                                                       AND has(added, toUUIDOrZero(splitByChar(':', pair)[2])), clicked)) AS total_converted_sessions,
    avgState(toInt64(dateDiff('millisecond', session_start, last_event_time))) AS avg_session_duration_ms
FROM analytics.sessions
ARRAY JOIN campaigns AS campaign_id
GROUP BY day, tenant_id, campaign_id;
