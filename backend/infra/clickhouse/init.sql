-- ClickHouse schema for analytics events: one row per event, written by the
-- Flink job (backend/flink) through Kafka (kafka.sql loads its topics) and read
-- by analytics-service for the /ad metrics.
CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.events
(
    event_id       UUID,
    event_name     LowCardinality(String),
    campaign_id    Nullable(UUID),
    product_id     Nullable(UUID),
    -- The person, from the sender's token: the same UUID before and after they
    -- register. NULL only for events from before visitors had one.
    user_id        Nullable(UUID),
    -- visitor (visitor token) or registered (access token).
    user_type      LowCardinality(String),
    -- web or mobile, from the sender's token. Events from before it was recorded are web.
    client_type    LowCardinality(String) DEFAULT 'web',
    -- From the sender's access or visitor token.
    tenant_id      UUID,
    page_name      Nullable(String),
    feature_name   Nullable(String),
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
-- One partition per day: copies of an event share event_time, so they merge
-- within it, and the TTL below drops a whole day at once.
PARTITION BY toDate(event_time)
-- Tenant first, then event: every query filters on tenant_id + event_name
-- (+ campaign_id and a time range), so it reads only that slice of the table.
ORDER BY (tenant_id, event_name, campaign_id, event_time, event_id)
-- Raw events are kept 14 days after they happened. /ad reads
-- daily_campaign_aggregation, which keeps every day. analytics-service accepts
-- events at most 5 days old, so a recounted day still has all of its raw
-- events; the days beyond that leave room for a nightly job that failed to run
-- again before the day is gone.
TTL toDateTime(event_time) + INTERVAL 14 DAY
-- campaign_id is Nullable (storefront activity may have no campaign).
-- The deduplication window makes an identical re-sent insert a no-op.
-- ttl_only_drop_parts: expired days are dropped as whole parts, never rewritten.
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Candidate clicks for each basket addition (add_to_cart): one row per (basket,
-- click), written by the Flink job as events arrive
-- (backend/flink/sql/pipelines/02_attributed_baskets.sql), for every click by the
-- same user on the same product in the 7 days before. The latest click wins (last
-- click): the largest (click_time, click_event_id) per (tenant_id,
-- basket_event_id); the views below pick it. Flink can't pick it itself, since a
-- click arriving late would have to retract a match it already wrote. Redelivered
-- rows are merged away like in events; counts use uniqExact(click_event_id,
-- product_id), once per winning click and product.
CREATE TABLE IF NOT EXISTS analytics.attributed_baskets
(
    basket_event_id UUID,
    click_event_id  UUID,
    tenant_id       UUID,
    campaign_id     UUID,
    product_id      Nullable(UUID),
    -- The basket addition's person and user type.
    user_id         Nullable(UUID),
    user_type       LowCardinality(String),
    -- The basket addition's client type (web or mobile).
    client_type     LowCardinality(String) DEFAULT 'web',
    -- When the basket addition happened (its day is the day it counts for).
    event_time      DateTime64(3, 'UTC'),
    click_time      DateTime64(3, 'UTC'),
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_ingested_at ingested_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(event_time)
ORDER BY (tenant_id, campaign_id, event_time, basket_event_id, click_event_id)
-- Kept as long as events; the daily totals keep every day.
TTL toDateTime(event_time) + INTERVAL 14 DAY
SETTINGS ttl_only_drop_parts = 1;


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

-- Deleted tenants (TenantDeleted, from analytics-service): their rows are
-- deleted from every table here, and kafka.sql's queue views drop any that a
-- replay from Kafka would bring back (Kafka keeps raw events up to 14 days).
-- archive_purged_at: when the archive job (airflow/dags/tenant_purge.py) deleted
-- the tenant's files from the Iceberg archive; the newest row per tenant wins.
CREATE TABLE IF NOT EXISTS analytics.deleted_tenants
(
    tenant_id         UUID,
    name              String,
    deleted_at        DateTime64(3, 'UTC'),
    archive_purged_at Nullable(DateTime64(3, 'UTC')),
    updated_at        DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY tenant_id;

-- Campaign totals per UTC day (of event_time: when the user acted), tenant and
-- campaign: one row each, with every count in total and per client type (web,
-- mobile), by the /ad counting rules. /ad reads its event counts only from here.
-- A basket addition counts under its own client type.
--
--   live:  the two views below add each insert into events and attributed_baskets
--          to its day's row as it is stored, so today's numbers are current;
--   check: every night, daily_campaign_aggregation_check_mv recounts the closed
--          days that got rows since the last run from raw events and adds the
--          difference, so past days are exact (a redelivered event, or the same
--          product credited twice to one click, counts once).
--
-- SummingMergeTree: each insert and correction is stored as a row of its own,
-- and background merges add the rows with the same key into one; queries sum(),
-- so they are right before that too. Signed columns, because the check can subtract.
CREATE TABLE IF NOT EXISTS analytics.daily_campaign_aggregation
(
    day                          Date,
    tenant_id                    UUID,
    campaign_id                  UUID,
    total_impressions            Int64,
    total_web_impressions        Int64,
    total_mobile_impressions     Int64,
    total_clicks                 Int64,
    total_web_clicks             Int64,
    total_mobile_clicks          Int64,
    total_click_to_basket        Int64,
    total_web_click_to_basket    Int64,
    total_mobile_click_to_basket Int64
)
ENGINE = SummingMergeTree
-- One partition per month: 12 a year, kept forever, and a closed month (no more
-- live or nightly writes) can be swapped whole by the history backfill
-- (airflow/jobs/backfill), which replaces it with ALTER TABLE ... REPLACE PARTITION.
PARTITION BY toYYYYMM(day)
-- One campaign's days are stored together: any date range is one small range read.
ORDER BY (tenant_id, campaign_id, day);

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

-- Unique customers per UTC day, tenant and campaign: one row each. A person
-- keeps their UUID when they register, so they count once whether they came as
-- a visitor, registered, or both.
--   has_visited*: the people (user_id) who saw or clicked the campaign;
--   customers_<metric>: the people behind each /ad metric: who saw it
--     (impressions), clicked it (clicks), or added a product to the cart after
--     clicking it (click_to_basket, credited to their latest click);
-- each in total and per client type (web, mobile) and user type (registered,
-- visitor). A distinct count can't be added up across days, client types or
-- user types (someone active on two days, or on web and mobile, would count
-- twice), so each column holds a uniqCombined64 sketch: sketches merge, and /ad
-- merges a period's days with uniqCombined64Merge. Those on both web and mobile
-- is web + mobile - total. Exact up to a few thousand customers, within about 1%
-- above that. A copy of an event adds the same customer again, which changes
-- nothing. The views below add each insert's customers as they are stored (a
-- view fills only its own columns; the others get empty sketches), and
-- AggregatingMergeTree merges them into the day's row. Sketches can't be
-- corrected by subtraction: a basket whose candidate clicks (in two campaigns)
-- arrive in different inserts leaves its customer in both campaigns'
-- click_to_basket customers, while the event count is corrected nightly.
CREATE TABLE IF NOT EXISTS analytics.daily_campaign_customers_aggregation
(
    day                                 Date,
    tenant_id                           UUID,
    campaign_id                         UUID,
    has_visited                         AggregateFunction(uniqCombined64, UUID),
    has_visited_in_web                  AggregateFunction(uniqCombined64, UUID),
    has_visited_in_mobile               AggregateFunction(uniqCombined64, UUID),
    has_visited_registered              AggregateFunction(uniqCombined64, UUID),
    has_visited_visitor                 AggregateFunction(uniqCombined64, UUID),
    customers_impressions               AggregateFunction(uniqCombined64, UUID),
    customers_web_impressions           AggregateFunction(uniqCombined64, UUID),
    customers_mobile_impressions        AggregateFunction(uniqCombined64, UUID),
    customers_registered_impressions    AggregateFunction(uniqCombined64, UUID),
    customers_visitor_impressions       AggregateFunction(uniqCombined64, UUID),
    customers_clicks                    AggregateFunction(uniqCombined64, UUID),
    customers_web_clicks                AggregateFunction(uniqCombined64, UUID),
    customers_mobile_clicks             AggregateFunction(uniqCombined64, UUID),
    customers_registered_clicks         AggregateFunction(uniqCombined64, UUID),
    customers_visitor_clicks            AggregateFunction(uniqCombined64, UUID),
    customers_click_to_basket           AggregateFunction(uniqCombined64, UUID),
    customers_web_click_to_basket       AggregateFunction(uniqCombined64, UUID),
    customers_mobile_click_to_basket    AggregateFunction(uniqCombined64, UUID),
    customers_registered_click_to_basket AggregateFunction(uniqCombined64, UUID),
    customers_visitor_click_to_basket   AggregateFunction(uniqCombined64, UUID)
)
ENGINE = AggregatingMergeTree
-- By month, like daily_campaign_aggregation (backfilled the same way).
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, campaign_id, day);

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

-- User sessions, written by the Flink job (backend/flink/sql/pipelines/03_sessions.sql):
-- one row per session of a user, which ends after 6 hours without events. A
-- session is written once, about 7 hours after its last event (the 6-hour gap +
-- the watermark's hour), so this table runs that far behind the others.
-- session_id is derived from (tenant, user, start), so a row Flink writes again
-- after a restart is the same session; ReplacingMergeTree merges it away.
CREATE TABLE IF NOT EXISTS analytics.sessions
(
    session_id      UUID,
    tenant_id       UUID,
    user_id         UUID,
    -- registered if any of its events was sent as registered.
    user_type       LowCardinality(String),
    session_start   DateTime64(3, 'UTC'),
    last_event_time DateTime64(3, 'UTC'),
    events          UInt32,
    impressions     UInt32,
    clicks          UInt32,
    add_to_carts    UInt32,
    -- Whether it had events from the web app, the mobile app (both: one session).
    web             Bool,
    mobile          Bool,
    -- The campaigns it saw or clicked.
    campaigns       Array(UUID),
    -- The clicks' "campaign_id:product_id" pairs.
    clicked         Array(String),
    -- The products it added to the cart.
    added           Array(UUID),
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(session_start)
ORDER BY (tenant_id, session_start, user_id)
-- Kept as long as the raw events; the daily session totals keep every day.
TTL toDateTime(session_start) + INTERVAL 14 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Sessions per UTC day (of the session's start), tenant and campaign seen in it:
-- one row each. Sessions are counted with sketches of session_id, so a session
-- written twice counts once; a converted session clicked the campaign and added
-- a product it clicked there to the cart in the same session. The average
-- duration (first to last event) would count a session written twice twice,
-- which only a Flink restart causes, and barely moves an average.
CREATE TABLE IF NOT EXISTS analytics.daily_campaign_sessions_aggregation
(
    day                      Date,
    tenant_id                UUID,
    campaign_id              UUID,
    total_sessions           AggregateFunction(uniqCombined64, UUID),
    total_converted_sessions AggregateFunction(uniqCombined64, UUID),
    avg_session_duration_ms  AggregateFunction(avg, Int64)
)
ENGINE = AggregatingMergeTree
-- By month, like daily_campaign_aggregation (backfilled the same way).
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, campaign_id, day);

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
