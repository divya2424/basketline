-- One-off upgrade for a volume created before user sessions came back
-- (flink/sql/pipelines/03_sessions.sql): the sessions staging table and its daily
-- table, their view, the Kafka table for serving.sessions.v1, and the row policy
-- on both (01_tables.sql to 04_access.sql). The daily table fills from now on; a
-- history backfill (airflow/jobs/backfill_daily.py --table
-- daily_campaign_sessions_aggregation) computes its past days from the data lake.
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery \
--     < infra/clickhouse/migrations/009_sessions.sql

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

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_campaign_sessions_aggregation_mv
TO analytics.daily_campaign_sessions_aggregation
AS SELECT
    toDate(session_start) AS day,
    tenant_id,
    toUUID(splitByChar(':', engaged)[1]) AS store_id,
    toUUID(splitByChar(':', engaged)[2]) AS campaign_id,
    uniqCombined64State(session_id) AS total_sessions,
    uniqCombined64StateIf(session_id, web) AS total_web_sessions,
    uniqCombined64StateIf(session_id, mobile) AS total_mobile_sessions,
    uniqCombined64StateIf(session_id, arrayExists(product -> has(clicked, concat(splitByChar(':', engaged)[2], ':', toString(product))), added))
        AS total_converted_sessions
FROM analytics.sessions
ARRAY JOIN campaigns AS engaged
GROUP BY day, tenant_id, store_id, campaign_id;

CREATE TABLE IF NOT EXISTS analytics.sessions_queue
(
    tenant_id     UUID,
    user_id       UUID,
    user_type     LowCardinality(String),
    session_start DateTime64(3, 'UTC'),
    session_end   DateTime64(3, 'UTC'),
    events        UInt32,
    web           Bool,
    mobile        Bool,
    campaigns     Array(String),
    clicked       Array(String),
    added         Array(UUID)
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:19092',
         kafka_topic_list = 'serving.sessions.v1',
         kafka_group_name = 'clickhouse-sessions',
         kafka_format = 'JSONEachRow',
         kafka_flush_interval_ms = 15000;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.sessions_queue_mv TO analytics.sessions
AS SELECT * FROM analytics.sessions_queue
WHERE tenant_id NOT IN (SELECT tenant_id FROM analytics.deleted_tenants)
  AND (tenant_id, user_id) NOT IN (SELECT tenant_id, user_id FROM analytics.deleted_users);

-- As in 04_access.sql, with the session tables.
DROP ROW POLICY IF EXISTS tenant_isolation ON
    analytics.events, analytics.attributed_baskets,
    analytics.daily_campaign_aggregation, analytics.daily_campaign_customers_aggregation;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON
    analytics.events, analytics.attributed_baskets, analytics.sessions,
    analytics.daily_campaign_aggregation, analytics.daily_campaign_customers_aggregation,
    analytics.daily_campaign_sessions_aggregation
    FOR SELECT USING tenant_id = toUUIDOrZero(getSetting('SQL_tenant_id'))
    TO basketline_reader;
