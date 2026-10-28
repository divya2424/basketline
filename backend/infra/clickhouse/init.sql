-- ClickHouse schema for analytics events: one row per event, written by the
-- Spark streaming job (backend/streaming, clickhouse-connect) and read by
-- analytics-service for the /ad metrics.
CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.events
(
    event_id       UUID,
    event_name     LowCardinality(String),
    campaign_id    Nullable(UUID),
    product_id     Nullable(UUID),
    user_id        Nullable(UUID),
    -- From the sender's access or visitor token.
    tenant_id      UUID,
    page_name      Nullable(String),
    feature_name   Nullable(String),
    -- For click_to_basket: the event_id of the click it is credited to.
    attribution_id Nullable(UUID),
    -- The event's properties as JSON text.
    properties     String,
    event_time     DateTime64(3, 'UTC'),
    received_at    DateTime64(3, 'UTC'),
    ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3),
    -- Finds the rows stored since the daily job's last run (late or reprocessed).
    INDEX idx_ingested_at ingested_at TYPE minmax GRANULARITY 1
)
-- Redelivered events (same event_id, so the same values in every key column)
-- are merged away in the background; queries count uniqExact(event_id), so
-- they are exact before that happens.
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(event_time)
-- Tenant first, then event: every query filters on tenant_id + event_name
-- (+ campaign_id and a time range), so it reads only that slice of the table.
ORDER BY (tenant_id, event_name, campaign_id, event_time, event_id)
-- Raw events are deleted 7 days after they happened (during background merges,
-- so they may linger a few hours longer). /ad reads days before yesterday from
-- campaign_daily_aggregates, which keeps them. analytics-service accepts events
-- at most 5 days old, so a recounted day still has all of its raw events.
TTL toDateTime(event_time) + INTERVAL 7 DAY
-- campaign_id is Nullable (storefront activity may have no campaign).
-- The deduplication window makes an identical re-sent insert (as when the Spark
-- job replays a batch after a crash) a no-op.
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 10000;


-- Each campaign's tenant and status, from campaign.v1 events (analytics-service).
-- Metric events are accepted only for a campaign of the sender's tenant that is
-- active and not archived.
-- The newest version wins, so replayed and out-of-order events are harmless.
CREATE TABLE IF NOT EXISTS analytics.campaigns
(
    campaign_id UUID,
    tenant_id   UUID,
    status      LowCardinality(String),
    archived    Bool,
    version     UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY campaign_id;

-- Campaign totals per UTC day (of event_time: when the user acted), tenant and
-- campaign, by the /ad counting rules, built by an hourly job in two steps:
--   1. campaign_daily_changes: which days got rows since the last run;
--   2. campaign_daily_aggregates: those days recounted from raw events.
-- A late or reprocessed event is stored with a new ingested_at, so the next run
-- recounts its day. Step 2 waits for step 1.

-- The daily totals (written by step 2). (tenant_id, campaign_id, day) is
-- unique: each run rebuilds the table (unchanged rows as they are, changed days recounted) and
-- swaps it in atomically, so there is never more than one row per key.
CREATE TABLE IF NOT EXISTS analytics.campaign_daily_aggregates
(
    day                   Date,
    tenant_id             UUID,
    campaign_id           UUID,
    total_ad_impressions  UInt64,
    total_ad_clicks       UInt64,
    total_click_to_basket UInt64,
    computed_at           DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, campaign_id, day);

-- Step 1 (every hour, at :05): days per tenant and campaign that got rows since
-- the last run, today included, so no row is ever left for a later run to find.
-- A click also marks the next day: baskets are credited up to 24h after it. The
-- hour of overlap covers rows stored while the last run was in progress; an
-- empty daily table means all history.
CREATE TABLE IF NOT EXISTS analytics.campaign_daily_changes
(
    day         Date,
    tenant_id   UUID,
    campaign_id UUID
)
ENGINE = MergeTree
ORDER BY (tenant_id, campaign_id, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.campaign_daily_changes_mv
REFRESH EVERY 1 HOUR OFFSET 5 MINUTE TO analytics.campaign_daily_changes
AS SELECT DISTINCT
    arrayJoin(if(event_name = 'click', [toDate(event_time), toDate(event_time) + 1], [toDate(event_time)])) AS day,
    tenant_id,
    assumeNotNull(campaign_id) AS campaign_id
FROM analytics.events
WHERE event_name IN ('impression', 'click', 'click_to_basket') AND campaign_id IS NOT NULL
  AND ingested_at >= (SELECT max(computed_at) FROM analytics.campaign_daily_aggregates) - INTERVAL 1 HOUR;

-- Step 2: rebuild the daily totals for the changed days. Impressions and clicks:
-- the day's distinct events (the sort key makes one campaign's day a small range
-- read). Basket additions: credited to a click on the same tenant's campaign at
-- most 24 hours before, for the same product (if it named one) and the same user
-- (if both were signed in), once per click, product and day.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.campaign_daily_aggregates_mv
REFRESH EVERY 1 HOUR OFFSET 5 MINUTE DEPENDS ON analytics.campaign_daily_changes_mv
TO analytics.campaign_daily_aggregates
AS SELECT day, tenant_id, campaign_id, total_ad_impressions, total_ad_clicks, total_click_to_basket, computed_at
FROM analytics.campaign_daily_aggregates
WHERE (day, tenant_id, campaign_id) NOT IN (SELECT day, tenant_id, campaign_id FROM analytics.campaign_daily_changes)

UNION ALL

SELECT
    day, tenant_id, campaign_id,
    sum(impressions) AS total_ad_impressions,
    sum(clicks) AS total_ad_clicks,
    sum(baskets) AS total_click_to_basket,
    now64(3, 'UTC') AS computed_at
FROM
(
    SELECT toDate(event_time) AS day, tenant_id, assumeNotNull(campaign_id) AS campaign_id,
           uniqExactIf(event_id, event_name = 'impression') AS impressions,
           uniqExactIf(event_id, event_name = 'click') AS clicks,
           toUInt64(0) AS baskets
    FROM analytics.events
    WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL
      AND event_time >= (SELECT min(day) FROM analytics.campaign_daily_changes)
      AND (toDate(event_time), tenant_id, assumeNotNull(campaign_id))
          IN (SELECT day, tenant_id, campaign_id FROM analytics.campaign_daily_changes)
    GROUP BY day, tenant_id, campaign_id

    UNION ALL

    SELECT toDate(basket.event_time) AS day, basket.tenant_id AS tenant_id, assumeNotNull(basket.campaign_id) AS campaign_id,
           toUInt64(0), toUInt64(0),
           uniqExact(basket.attribution_id, basket.product_id)
    FROM analytics.events AS basket
    INNER JOIN
    (
        SELECT DISTINCT event_id, tenant_id, campaign_id, product_id, user_id, event_time
        FROM analytics.events
        WHERE event_name = 'click' AND campaign_id IS NOT NULL
          AND event_time >= toDateTime64((SELECT min(day) FROM analytics.campaign_daily_changes), 3, 'UTC') - INTERVAL 1 DAY
          AND (tenant_id, assumeNotNull(campaign_id)) IN (SELECT tenant_id, campaign_id FROM analytics.campaign_daily_changes)
    ) AS click ON basket.attribution_id = click.event_id
    WHERE basket.event_name = 'click_to_basket' AND basket.campaign_id IS NOT NULL
      AND basket.event_time >= (SELECT min(day) FROM analytics.campaign_daily_changes)
      AND (toDate(basket.event_time), basket.tenant_id, assumeNotNull(basket.campaign_id))
          IN (SELECT day, tenant_id, campaign_id FROM analytics.campaign_daily_changes)
      AND basket.tenant_id = click.tenant_id AND basket.campaign_id = click.campaign_id
      AND basket.event_time >= click.event_time AND basket.event_time <= click.event_time + INTERVAL 24 HOUR
      AND (click.product_id IS NULL OR click.product_id = basket.product_id)
      AND (click.user_id IS NULL OR basket.user_id IS NULL OR click.user_id = basket.user_id)
    GROUP BY day, tenant_id, campaign_id
)
GROUP BY day, tenant_id, campaign_id;
