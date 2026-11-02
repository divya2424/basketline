-- One-off upgrade for a volume created before history backfills from the data
-- lake (01_tables.sql: analytics.backfill_runs, 04_access.sql: hidden from the reader).
--
--   docker compose exec -T clickhouse clickhouse-client --user basketline --password basketline_dev --multiquery \
--     < infra/clickhouse/migrations/008_backfill_runs.sql

CREATE TABLE IF NOT EXISTS analytics.backfill_runs
(
    run_id      UUID,
    started_at  DateTime64(3, 'UTC'),
    finished_at DateTime64(3, 'UTC'),
    from_day    Date,
    to_day      Date,
    tenants     Array(UUID),
    tables      Array(String),
    rows        Map(String, UInt64),
    rolled_back Bool DEFAULT false
)
ENGINE = MergeTree
ORDER BY started_at;

REVOKE SELECT ON analytics.backfill_runs FROM basketline_reader;
