-- ClickHouse schema, part 1 of 3: the database and its tables. The Flink job
-- (backend/flink) writes events, attributed_baskets and sessions through Kafka
-- (03_kafka.sql loads its topics); the materialized views (02_materialized_views.sql)
-- fill the daily tables, which analytics-service reads for the /ad metrics.
-- The files run in name order, on a new volume only (docker-entrypoint-initdb.d).
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
    -- interaction or identity (contracts: analytics.ts).
    event_type     LowCardinality(String) DEFAULT 'interaction',
    -- The seller of product_id, from the catalog, stamped on arrival; NULL without a
    -- product or for one the catalog hadn't sent yet (the products table has it later).
    seller_id      Nullable(UUID),
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
-- Raw events are kept 20 days after they happened. /ad reads
-- daily_campaign_aggregation, which keeps every day. analytics-service accepts
-- events at most 5 days old, so a recounted day still has all of its raw
-- events. A Flink checkpoint reset replays Kafka's 14 days of arrivals, which
-- hold events up to 19 days old: every day it writes to is still here, so the
-- hourly check deduplicates it instead of recounting a day from a few replayed
-- rows. The extra day is margin.
-- After 7 days a day moves to S3 (the 'tiered' policy, config/storage.xml): the
-- hourly check reads days that got late rows, at most 5 days old, so it reads
-- local disk; older days are read only by rebuilds and the archive.
TTL toDateTime(event_time) + INTERVAL 7 DAY TO VOLUME 'cold',
    toDateTime(event_time) + INTERVAL 20 DAY
-- campaign_id is Nullable (storefront activity may have no campaign).
-- The deduplication window makes an identical re-sent insert a no-op.
-- ttl_only_drop_parts: expired days are dropped as whole parts, never rewritten.
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1, storage_policy = 'tiered';

-- Candidate clicks for each basket addition (add_to_cart): one row per (basket,
-- click), written by the Flink job as events arrive
-- (backend/flink/sql/pipelines/02_attributed_baskets.sql), for every click by the
-- same user on the same product in the 7 days before. The latest click wins (last
-- click): the largest (click_time, click_event_id) per (tenant_id,
-- basket_event_id); the materialized views pick it (02_materialized_views.sql). Flink can't pick it itself, since a
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
    -- The basket addition's product's seller (as on its event).
    seller_id       Nullable(UUID),
    INDEX idx_ingested_at ingested_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(event_time)
ORDER BY (tenant_id, campaign_id, event_time, basket_event_id, click_event_id)
-- Kept and moved to S3 like events; the daily totals keep every day.
TTL toDateTime(event_time) + INTERVAL 7 DAY TO VOLUME 'cold',
    toDateTime(event_time) + INTERVAL 20 DAY
SETTINGS ttl_only_drop_parts = 1, storage_policy = 'tiered';


-- Reference data, from the retailer's server (contracts: retail.ts), through
-- retail.catalog-events.v1 and retail.campaign-events.v1 (analytics-service). The
-- newest version (updatedAt) wins, so replayed and out-of-order updates are harmless.

-- Each campaign's tenant, seller and status. Metric events are accepted only for a
-- campaign of the sender's tenant that is active and not archived; a seller-manager
-- sees only its seller's. issues: what is wrong with it (a product of another
-- seller, or one the catalog hasn't sent), kept and flagged rather than refused.
CREATE TABLE IF NOT EXISTS analytics.campaigns
(
    campaign_id UUID,
    tenant_id   UUID,
    status      LowCardinality(String),
    archived    Bool,
    version     UInt64,
    seller_id   Nullable(UUID),
    issues      Array(String) DEFAULT []
)
ENGINE = ReplacingMergeTree(version)
ORDER BY campaign_id;

-- Each tenant's sellers (a store without any has its first-party seller).
CREATE TABLE IF NOT EXISTS analytics.sellers
(
    seller_id UUID,
    tenant_id UUID,
    name      String,
    version   UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (tenant_id, seller_id);

-- Each product's seller and details; a removed product is kept (removed), so its
-- events still have their seller.
CREATE TABLE IF NOT EXISTS analytics.products
(
    product_id UUID,
    tenant_id  UUID,
    seller_id  UUID,
    name       String,
    category   Nullable(String),
    price      Nullable(Float64),
    is_active  Bool,
    removed    Bool DEFAULT false,
    version    UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (tenant_id, product_id);

-- Shoppers erased at the retailer's request (user_deleted, from analytics-service):
-- their rows are deleted here at once, and from the Iceberg archive by the purge
-- job (airflow/jobs/purge_tenants.py), which sets archive_purged_at.
CREATE TABLE IF NOT EXISTS analytics.deleted_users
(
    tenant_id         UUID,
    user_id           UUID,
    deleted_at        DateTime64(3, 'UTC'),
    archive_purged_at Nullable(DateTime64(3, 'UTC')),
    updated_at        DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, user_id);

-- Deleted tenants (TenantDeleted, from analytics-service): their rows are
-- deleted from every table here, and 03_kafka.sql's queue views drop any that a
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

-- Events rejected as invalid traffic (analytics-service: declared bots by user
-- agent), per UTC day received, tenant and reason, so they can be reported next to
-- the metrics they were kept out of. SummingMergeTree: queries sum(events).
CREATE TABLE IF NOT EXISTS analytics.invalid_traffic_daily
(
    day       Date,
    tenant_id UUID,
    reason    LowCardinality(String),
    events    UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, day, reason);

-- Campaign totals per UTC day (of event_time: when the user acted), tenant and
-- campaign: one row each, with every count in total and per client type (web,
-- mobile), by the /ad counting rules. /ad reads its event counts only from here.
-- A basket addition counts under its own client type.
--
--   live:  two materialized views (02_materialized_views.sql) add each insert into events and attributed_baskets
--          to its day's row as it is stored, so today's numbers are current;
--   check: every hour, daily_campaign_aggregation_check_mv recounts the days
--          (today included) that got rows since the last run from raw events and
--          adds the difference, so every day is exact within the hour (a
--          redelivered event, or the same product credited twice to one click,
--          counts once).
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
-- nothing. Its materialized views (02_materialized_views.sql) add each insert's customers as they are stored (a
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
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    -- The sellers of the products it touched.
    sellers         Array(UUID) DEFAULT []
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(session_start)
ORDER BY (tenant_id, session_start, user_id)
-- Kept and moved to S3 like the raw events; the daily session totals keep every day.
TTL toDateTime(session_start) + INTERVAL 7 DAY TO VOLUME 'cold',
    toDateTime(session_start) + INTERVAL 20 DAY
SETTINGS ttl_only_drop_parts = 1, storage_policy = 'tiered';

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
