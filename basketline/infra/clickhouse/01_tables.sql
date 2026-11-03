-- ClickHouse schema, part 1 of 4: the database and its tables. ClickHouse holds
-- only what the /ad metrics need: the daily aggregates per tenant, store and
-- campaign, the last few days of the Flink job's output they're counted from
-- (staging), and the erasure records that keep deleted data out. Everything else
-- (original events, campaigns, products, the catalog, tenants) is in the data
-- lake (basketline/connect). The Flink job (basketline/flink) writes the staging
-- tables through Kafka (03_kafka.sql); the materialized views
-- (02_materialized_views.sql) fill the daily tables, which insights-service reads.
-- The files run in name order, on a new volume only (docker-entrypoint-initdb.d).
CREATE DATABASE IF NOT EXISTS analytics;

-- Staging: every ad impression and click (the Flink job's serving.events.v1), kept
-- 3 days. ingestion-service accepts events up to 2 days old, so every day a new
-- event can change is still here when the hourly check recounts it exactly.
-- ReplacingMergeTree: a copy of an event (a retry, a Flink restart) has the same
-- sort key and merges away.
CREATE TABLE IF NOT EXISTS analytics.events
(
    event_id    UUID,
    event_name  LowCardinality(String),
    tenant_id   UUID,
    store_id    UUID,
    campaign_id UUID,
    product_id  Nullable(UUID),
    user_id     Nullable(UUID),
    user_type   LowCardinality(String),
    client_type LowCardinality(String),
    event_time  DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    -- When ClickHouse stored it: the hourly check recounts the days that got rows recently.
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX ingested_at_idx ingested_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(event_time)
ORDER BY (tenant_id, store_id, campaign_id, event_name, event_time, event_id)
-- A whole day goes at once, 3 days after it.
TTL toDateTime(event_time) + INTERVAL 3 DAY
SETTINGS non_replicated_deduplication_window = 10000, ttl_only_drop_parts = 1;

-- Staging: each basket addition paired with every click that could have led to it
-- (the Flink job's serving.attributed_baskets.v1); the materialized views credit
-- the latest click. Kept 3 days, like events.
CREATE TABLE IF NOT EXISTS analytics.attributed_baskets
(
    basket_event_id UUID,
    click_event_id  UUID,
    tenant_id       UUID,
    -- The store of the basket addition, which it is counted under.
    store_id        UUID,
    campaign_id     UUID,
    product_id      Nullable(UUID),
    user_id         Nullable(UUID),
    user_type       LowCardinality(String),
    client_type     LowCardinality(String),
    -- When the product was added to the cart.
    event_time      DateTime64(3, 'UTC'),
    click_time      DateTime64(3, 'UTC'),
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(event_time)
ORDER BY (tenant_id, store_id, campaign_id, event_time, basket_event_id, click_event_id)
TTL toDateTime(event_time) + INTERVAL 3 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Staging: each user session (the Flink job's serving.sessions.v1,
-- flink/sql/pipelines/03_sessions.sql): a user's interactions with no gap of 30
-- minutes, written about 40 minutes after its last one. Kept 3 days, like events.
-- session_id comes from (tenant, user, start), so a session Flink writes again
-- after a restart is the same one, merged away and counted once.
--   campaigns: "store_id:campaign_id" of each campaign it saw or clicked;
--   clicked:   "campaign_id:product_id" of each click;
--   added:     the products it added to the cart.
CREATE TABLE IF NOT EXISTS analytics.sessions
(
    tenant_id     UUID,
    user_id       UUID,
    -- registered if any of its events was sent signed in.
    user_type     LowCardinality(String),
    session_start DateTime64(3, 'UTC'),
    session_end   DateTime64(3, 'UTC'),
    events        UInt32,
    -- Whether it had events from the web app, the mobile app (both: one session).
    web           Bool,
    mobile        Bool,
    campaigns     Array(String),
    clicked       Array(String),
    added         Array(UUID),
    session_id    UUID DEFAULT reinterpretAsUUID(sipHash128(tenant_id, user_id, session_start)),
    ingested_at   DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(session_start)
ORDER BY (tenant_id, session_start, user_id)
TTL toDateTime(session_start) + INTERVAL 3 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Shoppers erased at the store's request (user_deleted, from ingestion-service):
-- their staged rows are deleted at once, and 03_kafka.sql's queue views drop any
-- still in flight. The daily tables hold no user IDs (counts and sketches).
-- lake_purged_at: when the purge job (airflow/dags/tenant_purge.py) deleted
-- their rows from the data lake; the newest row per shopper wins.
CREATE TABLE IF NOT EXISTS analytics.deleted_users
(
    tenant_id      UUID,
    user_id        UUID,
    deleted_at     DateTime64(3, 'UTC'),
    lake_purged_at Nullable(DateTime64(3, 'UTC')),
    updated_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, user_id);

-- Deleted tenants (TenantDeleted, from ingestion-service): their rows are
-- deleted from every table here, and 03_kafka.sql's queue views drop any that a
-- replay from Kafka would bring back (Kafka keeps raw events up to 14 days).
-- lake_purged_at: when the purge job (airflow/dags/tenant_purge.py) deleted the
-- tenant's rows from the data lake; the newest row per tenant wins.
CREATE TABLE IF NOT EXISTS analytics.deleted_tenants
(
    tenant_id      UUID,
    name           String,
    deleted_at     DateTime64(3, 'UTC'),
    lake_purged_at Nullable(DateTime64(3, 'UTC')),
    updated_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY tenant_id;

-- Campaign totals per UTC day (of event_time: when the user acted), tenant, store
-- and campaign: one row each, with every count in total and per client type (web,
-- mobile). /ad reads its event counts only from here. A basket addition counts
-- under its own store and client type.
--
--   live:  materialized views (02_materialized_views.sql) add each insert into the
--          staging tables to its day's row as it is stored. An insert holds the
--          days its events happened on, so today's row changes, and an older day's
--          only when a late event for it arrives; the other days stay as they are;
--   check: every hour, daily_campaign_aggregation_check_mv recounts only the days
--          that got rows in the last 3 hours (today, or a late event's day) from
--          staging and adds the difference, so they are exact within the hour (a
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
    store_id                     UUID,
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
-- One partition per month: 12 a year, kept forever.
PARTITION BY toYYYYMM(day)
-- One campaign's days are stored together: any date range is one small range read.
ORDER BY (tenant_id, store_id, campaign_id, day);

-- Unique customers per UTC day, tenant, store and campaign: one row each. A
-- shopper keeps their visitor UUID when they sign in, so they count once whether
-- they came as a visitor, signed in, or both.
--   has_visited*: the people (user_id) who saw or clicked the campaign;
--   customers_<metric>: the people behind each /ad metric: who saw it
--     (impressions), clicked it (clicks), or added a product to the cart after
--     clicking it (click_to_basket, credited to their latest click);
-- each in total and per client type (web, mobile) and user type (registered,
-- visitor). A distinct count can't be added up across days, stores, client types
-- or user types (someone active on two days, or on web and mobile, would count
-- twice), so each column holds a uniqCombined64 sketch: sketches merge, and /ad
-- merges a period's days (and stores) with uniqCombined64Merge. Those on both web
-- and mobile is web + mobile - total. Exact up to a few thousand customers,
-- within about 1% above that. A copy of an event adds the same customer again,
-- which changes nothing. Its materialized views (02_materialized_views.sql) add
-- each insert's customers as they are stored, so like the counts only the days in
-- an insert change; AggregatingMergeTree merges them into the day's row.
CREATE TABLE IF NOT EXISTS analytics.daily_campaign_customers_aggregation
(
    day                                  Date,
    tenant_id                            UUID,
    store_id                             UUID,
    campaign_id                          UUID,
    has_visited                          AggregateFunction(uniqCombined64, UUID),
    has_visited_in_web                   AggregateFunction(uniqCombined64, UUID),
    has_visited_in_mobile                AggregateFunction(uniqCombined64, UUID),
    has_visited_registered               AggregateFunction(uniqCombined64, UUID),
    has_visited_visitor                  AggregateFunction(uniqCombined64, UUID),
    customers_impressions                AggregateFunction(uniqCombined64, UUID),
    customers_web_impressions            AggregateFunction(uniqCombined64, UUID),
    customers_mobile_impressions         AggregateFunction(uniqCombined64, UUID),
    customers_registered_impressions     AggregateFunction(uniqCombined64, UUID),
    customers_visitor_impressions        AggregateFunction(uniqCombined64, UUID),
    customers_clicks                     AggregateFunction(uniqCombined64, UUID),
    customers_web_clicks                 AggregateFunction(uniqCombined64, UUID),
    customers_mobile_clicks              AggregateFunction(uniqCombined64, UUID),
    customers_registered_clicks          AggregateFunction(uniqCombined64, UUID),
    customers_visitor_clicks             AggregateFunction(uniqCombined64, UUID),
    customers_click_to_basket            AggregateFunction(uniqCombined64, UUID),
    customers_web_click_to_basket        AggregateFunction(uniqCombined64, UUID),
    customers_mobile_click_to_basket     AggregateFunction(uniqCombined64, UUID),
    customers_registered_click_to_basket AggregateFunction(uniqCombined64, UUID),
    customers_visitor_click_to_basket    AggregateFunction(uniqCombined64, UUID)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, store_id, campaign_id, day);

-- Sessions per UTC day (of the session's start), tenant, store and campaign: the
-- sessions that saw or clicked the campaign in that store, in total, with web or
-- mobile events, and converted (added to the cart a product clicked in the
-- campaign, in the same session). uniqCombined64 sketches of session_id, like
-- the customers' table: a session written twice counts once, and a period's
-- days and stores merge. Filled by 02_materialized_views.sql as sessions are stored.
CREATE TABLE IF NOT EXISTS analytics.daily_campaign_sessions_aggregation
(
    day                      Date,
    tenant_id                UUID,
    store_id                 UUID,
    campaign_id              UUID,
    total_sessions           AggregateFunction(uniqCombined64, UUID),
    total_web_sessions       AggregateFunction(uniqCombined64, UUID),
    total_mobile_sessions    AggregateFunction(uniqCombined64, UUID),
    total_converted_sessions AggregateFunction(uniqCombined64, UUID)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, store_id, campaign_id, day);

-- A campaign's results per product: impressions, clicks and credited basket
-- additions per UTC day, tenant, store, campaign and product (GET /ad/{id}/products,
-- e.g. for a seller's portal). Filled live by 02_materialized_views.sql with the
-- same rules as daily_campaign_aggregation, and corrected hourly by its own check
-- (a copy of an event stored in a later insert, after a Flink restart or a
-- replay, counts until then). Impressions and clicks without a product aren't
-- counted here.
CREATE TABLE IF NOT EXISTS analytics.daily_campaign_product_aggregation
(
    day             Date,
    tenant_id       UUID,
    store_id        UUID,
    campaign_id     UUID,
    product_id      UUID,
    impressions     Int64,
    clicks          Int64,
    click_to_basket Int64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, store_id, campaign_id, product_id, day);

-- The products added to each campaign, with their details as last sent
-- (retail.campaign-products.v1, by 03_kafka.sql): only to name the products in
-- GET /ad/{id}/products. A product taken out of a campaign keeps its row, since its
-- past results still need a name. ReplacingMergeTree: the latest update wins.
CREATE TABLE IF NOT EXISTS analytics.campaign_products
(
    tenant_id     UUID,
    campaign_id   UUID,
    product_id    UUID,
    store_id      UUID,
    product_name  String,
    product_price Nullable(Float64),
    category      Nullable(String),
    updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, campaign_id, product_id);

-- Each tenant's campaigns and whether they're running (retail.campaign-events.v1,
-- by 03_kafka.sql): ingestion-service counts impressions and clicks only for a
-- tenant's active campaigns. A removed campaign keeps its row, as status
-- 'removed'. ReplacingMergeTree: the latest update wins.
CREATE TABLE IF NOT EXISTS analytics.campaigns
(
    tenant_id   UUID,
    campaign_id UUID,
    status      LowCardinality(String),
    archived    Bool,
    updated_at  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, campaign_id);

-- Each history backfill (airflow/jobs/backfill_daily.py): the days and tenants it
-- recomputed from the data lake, the daily tables it replaced and their recomputed
-- rows. Not for the tenant-scoped reader (04_access.sql).
CREATE TABLE IF NOT EXISTS analytics.backfill_runs
(
    run_id      UUID,
    started_at  DateTime64(3, 'UTC'),
    finished_at DateTime64(3, 'UTC'),
    from_day    Date,
    to_day      Date,
    -- Empty: every tenant.
    tenants     Array(UUID),
    tables      Array(String),
    rows        Map(String, UInt64),
    rolled_back Bool DEFAULT false
)
ENGINE = MergeTree
ORDER BY started_at;
