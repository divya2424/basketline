-- ClickHouse schema, part 0: functions, shared by the views (03_kafka.sql) and
-- the history backfill (airflow/jobs/backfill/load_backfill.py), so each rule is
-- written once. Functions belong to the server, not a database.

-- A session's ID: the same (tenant, user, start) always gives the same ID, so a
-- session written again (a Flink restart, a backfill) is the same session.
CREATE FUNCTION IF NOT EXISTS sessionId AS (tenant_id, user_id, session_start) ->
    reinterpretAsUUID(MD5(concat(toString(tenant_id), toString(user_id), toString(session_start))));
