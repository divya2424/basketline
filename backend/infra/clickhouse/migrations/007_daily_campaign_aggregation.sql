-- One-off upgrade for a ClickHouse volume created before daily_campaign_aggregation
-- replaced the hourly campaign_daily_aggregates job (init.sql only runs on an
-- empty volume). It creates the table, fills it with every day counted so far,
-- and drops the old job; init.sql then creates the live and nightly views.
-- Stop the Flink job first, so no events are stored between the fill and the
-- live views starting:
--
--   CH="docker compose exec -T clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev --multiquery"
--   docker compose stop flink-streaming
--   $CH < infra/clickhouse/migrations/007_daily_campaign_aggregation.sql
--   $CH < infra/clickhouse/init.sql
--   docker compose up -d --build analytics-service flink-streaming

CREATE TABLE IF NOT EXISTS analytics.daily_campaign_aggregation
(
    day             Date,
    tenant_id       UUID,
    campaign_id     UUID,
    impressions     Int64,
    clicks          Int64,
    click_to_basket Int64
)
ENGINE = SummingMergeTree
PARTITION BY toYear(day)
ORDER BY (tenant_id, campaign_id, day);

-- Days more than 5 days ago, whose raw events may have expired: as the old job saved them.
INSERT INTO analytics.daily_campaign_aggregation
SELECT day, tenant_id, campaign_id, toInt64(total_ad_impressions), toInt64(total_ad_clicks), toInt64(total_click_to_basket)
FROM analytics.campaign_daily_aggregates
WHERE day < toDate(now('UTC')) - 5;

-- The last 6 days: counted from raw events, which are all still kept.
INSERT INTO analytics.daily_campaign_aggregation
SELECT day, tenant_id, campaign_id, sum(i), sum(c), sum(b)
FROM
(
    SELECT toDate(event_time) AS day, tenant_id, assumeNotNull(campaign_id) AS campaign_id,
           toInt64(uniqExactIf(event_id, event_name = 'impression')) AS i,
           toInt64(uniqExactIf(event_id, event_name = 'click')) AS c,
           toInt64(0) AS b
    FROM analytics.events
    WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL
      AND toDate(event_time) >= toDate(now('UTC')) - 5
    GROUP BY day, tenant_id, campaign_id

    UNION ALL

    SELECT toDate(event_time) AS day, tenant_id, campaign_id,
           toInt64(0), toInt64(0), toInt64(uniqExact(click_event_id, product_id))
    FROM analytics.attributed_baskets
    WHERE toDate(event_time) >= toDate(now('UTC')) - 5
    GROUP BY day, tenant_id, campaign_id
)
GROUP BY day, tenant_id, campaign_id;

DROP VIEW IF EXISTS analytics.campaign_daily_aggregates_mv;
DROP VIEW IF EXISTS analytics.campaign_daily_changes_mv;
DROP TABLE IF EXISTS analytics.campaign_daily_aggregates;
DROP TABLE IF EXISTS analytics.campaign_daily_changes;
