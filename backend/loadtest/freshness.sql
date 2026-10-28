-- End-to-end freshness of one load-test run: from analytics-service receiving an
-- event (received_at) to ClickHouse storing it (ingested_at), i.e. Kafka plus the
-- Spark micro-batch. Every event of the run is counted, not a sample.
SELECT
    {run:String} AS run_id,
    count() AS rows_stored,
    uniqExact(event_id) AS events_stored,
    quantileExact(0.5)(ms) AS p50_ms,
    quantileExact(0.99)(ms) AS p99_ms,
    max(ms) AS max_ms
FROM
(
    SELECT event_id, dateDiff('millisecond', received_at, ingested_at) AS ms
    FROM analytics.events
    WHERE tenant_id = toUUID('0ad7e570-0000-4000-8000-000000000001') AND JSONExtractString(properties, 'loadtest_run') = {run:String}
)
FORMAT JSONEachRow
