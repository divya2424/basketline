"""Recomputes ClickHouse's daily tables for past days from the data lake.

    python backfill_daily.py --from 2026-11-01 --to 2026-11-05 [--tenant <uuid> ...] [--table <name> ...]
    python backfill_daily.py --rollback

For a correction (a counting bug fixed, data that never arrived) or a new daily
table's history. The lake (Kafka Connect, basketline/connect) keeps every
interaction ever sent; ClickHouse keeps only the daily totals, recomputed here:

  1. A scratch database (analytics_backfill) is created from the real schema
     (infra/clickhouse/01_tables.sql, 02_materialized_views.sql), so the daily
     rows are computed by the same materialized views as live ones, every daily
     table included.
  2. For each day, the lake's events are inserted into its staging tables as the
     Flink job writes them (flink/sql): ad impressions and clicks with a
     campaign, each basket addition with every click on its product by the
     same user in the 7 days before it (the views credit the latest), and the
     sessions that began that day. Each event once (by event ID); deleted
     tenants and erased shoppers left out.
  3. Each month the days are in is swapped into analytics atomically (REPLACE
     PARTITION): the recomputed rows, plus the rows of every other day and tenant
     as they are. While it swaps, ClickHouse stops reading Kafka and the hourly
     check waits, so no live row is lost (Kafka keeps them; reading resumes
     after). The scratch database, with the months as they were, stays until
     the next run (to look into it, or --rollback to put those months back).

Only days the lake holds whole and no live event can still change: from the
first full day after the lake began, to 3 days ago (events arrive at most 2 days
late). Each run is recorded in analytics.backfill_runs.
"""

import argparse
import datetime as dt
import os
import re
import time
import uuid
from pathlib import Path

import clickhouse_connect

SCHEMA = Path(os.environ.get("CLICKHOUSE_SCHEMA_DIR", "/opt/airflow/clickhouse"))
NO_STORE = "00000000-0000-0000-0000-000000000000"
# A day can still get events until 2 days after it (ingestion-service's MAX_EVENT_AGE_MS).
SETTLED_DAYS = 3
# Live inserts into the staging tables (03_kafka.sql) and the hourly recounts (02_materialized_views.sql).
QUEUE_VIEWS = ["events_queue_mv", "attributed_baskets_queue_mv", "sessions_queue_mv"]
CHECK_VIEWS = ["daily_campaign_aggregation_check_mv", "daily_campaign_product_aggregation_check_mv"]

# The lake's interaction events between two Kafka times (the lake's hourly
# partitions), with their fields as the Flink job reads them (flink/sql/views/).
PARSED = """
    SELECT toUUIDOrNull(payload_eventId) AS event_id, payload_eventName AS event_name,
           toUUIDOrNull(payload_tenantId) AS tenant_id,
           ifNull(toUUIDOrNull(payload_storeId), toUUID('{no_store}')) AS store_id,
           toUUIDOrNull(payload_campaignId) AS campaign_id,
           toUUIDOrNull(payload_productId) AS product_id,
           toUUIDOrNull(payload_userId) AS user_id,
           if(payload_userType IN ('visitor', 'registered'), payload_userType, 'visitor') AS user_type,
           if(payload_clientType IN ('web', 'mobile'), payload_clientType, 'web') AS client_type,
           parseDateTime64BestEffortOrNull(payload_timestamp, 3, 'UTC') AS event_time,
           ifNull(parseDateTime64BestEffortOrNull(payload_receivedAt, 3, 'UTC'), event_time) AS received_at
    FROM {source}
    WHERE _kafka_metadata_timestamp >= {{day:Date}} - INTERVAL {before} DAY
      AND _kafka_metadata_timestamp < {{day:Date}} + INTERVAL {after} DAY
"""

# Valid events, each once, without deleted tenants or erased shoppers, of the tenants in scope.
VALID = """
    SELECT * FROM ({parsed})
    WHERE event_id IS NOT NULL AND tenant_id IS NOT NULL AND event_time IS NOT NULL
      AND tenant_id NOT IN (SELECT tenant_id FROM {database}.deleted_tenants)
      AND (user_id IS NULL OR (tenant_id, assumeNotNull(user_id)) NOT IN (SELECT tenant_id, user_id FROM {database}.deleted_users))
      AND (empty({{tenants:Array(UUID)}}) OR has({{tenants:Array(UUID)}}, tenant_id))
    LIMIT 1 BY event_id
"""

# The day's ad impressions and clicks (flink/sql/pipelines/01_serving_events.sql).
# An event arrives at most 5 minutes early (clock skew) and 2 days late.
EVENTS = """
    INSERT INTO {scratch}.events (event_id, event_name, tenant_id, store_id, campaign_id, product_id, user_id, user_type, client_type, event_time, received_at)
    SELECT event_id, event_name, tenant_id, store_id, assumeNotNull(campaign_id), product_id, user_id, user_type, client_type, event_time, received_at
    FROM ({valid})
    WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL AND toDate(event_time) = {{day:Date}}
"""

# The day's basket additions, each with every click on its product by the same
# user in the 7 days before it (flink/sql/pipelines/02_attributed_baskets.sql).
# All of a basket's candidates are in the same insert, so the views credit its latest click.
ATTRIBUTED = """
    INSERT INTO {scratch}.attributed_baskets (basket_event_id, click_event_id, tenant_id, store_id, campaign_id, product_id, user_id, user_type, client_type, event_time, click_time)
    WITH valid AS ({valid}),
    baskets AS (
        SELECT * FROM valid
        WHERE event_name = 'add_to_cart' AND product_id IS NOT NULL AND user_id IS NOT NULL AND toDate(event_time) = {{day:Date}}
    ),
    clicks AS (
        SELECT * FROM valid
        WHERE event_name = 'click' AND campaign_id IS NOT NULL AND product_id IS NOT NULL AND user_id IS NOT NULL
    )
    SELECT b.event_id, c.event_id, b.tenant_id, b.store_id, assumeNotNull(c.campaign_id), b.product_id, b.user_id, b.user_type, b.client_type, b.event_time, c.event_time
    FROM baskets AS b
    INNER JOIN clicks AS c ON b.tenant_id = c.tenant_id AND b.user_id = c.user_id AND b.product_id = c.product_id
    WHERE b.event_time >= c.event_time AND b.event_time <= c.event_time + INTERVAL 7 DAY
"""

# The sessions that began on the day (flink/sql/pipelines/03_sessions.sql): a known
# user's interactions with no gap of 30 minutes or more. The day before tells
# whether the day's first events continue a session, and the day after holds the
# end of one that runs past midnight. Unlike Flink, no event is too late for its session.
SESSIONS = """
    INSERT INTO {scratch}.sessions (tenant_id, user_id, user_type, session_start, session_end, events, web, mobile, campaigns, clicked, added)
    WITH ordered AS (
        SELECT *, lagInFrame(event_time, 1, toDateTime64(0, 3, 'UTC')) OVER (
                      PARTITION BY tenant_id, user_id ORDER BY event_time, event_id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS previous_time
        FROM ({valid})
        WHERE user_id IS NOT NULL
          AND event_time >= {{day:Date}} - INTERVAL 1 DAY AND event_time < {{day:Date}} + INTERVAL 2 DAY
    ),
    numbered AS (
        SELECT *, sum(event_time >= previous_time + INTERVAL 30 MINUTE) OVER (
                      PARTITION BY tenant_id, user_id ORDER BY event_time, event_id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session
        FROM ordered
    )
    SELECT tenant_id, assumeNotNull(user_id),
           if(countIf(user_type = 'registered') > 0, 'registered', 'visitor'),
           min(event_time), max(event_time), count(), countIf(client_type = 'web') > 0, countIf(client_type = 'mobile') > 0,
           groupUniqArrayIf(concat(toString(store_id), ':', toString(assumeNotNull(campaign_id))), event_name IN ('impression', 'click') AND campaign_id IS NOT NULL),
           groupUniqArrayIf(concat(toString(assumeNotNull(campaign_id)), ':', toString(assumeNotNull(product_id))),
                            event_name = 'click' AND campaign_id IS NOT NULL AND product_id IS NOT NULL),
           groupUniqArrayIf(assumeNotNull(product_id), event_name = 'add_to_cart' AND product_id IS NOT NULL)
    FROM numbered
    GROUP BY tenant_id, user_id, session
    HAVING toDate(min(event_time)) = {{day:Date}}
"""


def statements(file: str, database: str) -> list[str]:
    """A schema file's statements, for `database` instead of analytics."""
    text = re.sub(r"--.*$", "", (SCHEMA / file).read_text(), flags=re.M)
    text = re.sub(r"\banalytics\b", database, text)
    return [statement.strip() for statement in text.split(";") if statement.strip()]


def lake_source(url: str, key: str | None, secret: str | None) -> str:
    """The lake's interactions table. Without keys, ClickHouse's own credentials (its IAM role on AWS)."""
    quote = lambda value: "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"  # noqa: E731
    return f"icebergS3({quote(url)}, {quote(key)}, {quote(secret)})" if key else f"icebergS3({quote(url)})"


def days(start: dt.date, end: dt.date) -> list[dt.date]:
    return [start + dt.timedelta(days=n) for n in range((end - start).days + 1)]


def tables_in(ch, database: str) -> set[str]:
    return {row[0] for row in ch.query("SELECT name FROM system.tables WHERE database = {db:String}", parameters={"db": database}).result_rows}


def check_range(ch, source: str, start: dt.date, end: dt.date, today: dt.date) -> None:
    """Refuses days the lake doesn't hold whole, or that live events can still change."""
    if start > end:
        raise ValueError(f"--from {start} is after --to {end}")
    if end > today - dt.timedelta(days=SETTLED_DAYS):
        raise ValueError(f"--to {end} can still get events: at most {today - dt.timedelta(days=SETTLED_DAYS)}")
    began = ch.query(f"SELECT min(_kafka_metadata_timestamp) FROM {source}").result_rows[0][0]
    if began is None or start <= began.date():
        raise ValueError(f"--from {start} isn't in the lake whole: it began {began}, so at the earliest {began.date() + dt.timedelta(days=1) if began else '-'}")


def check_lake_caught_up(ch, source: str, end: dt.date) -> None:
    """Refuses while the lake may still lack events of the days: the last one's can arrive until 3 days after it.

    A lake that is behind (Kafka Connect stopped, or its storage down) would replace
    correct live counts with partial ones, so a scheduled run waits for it."""
    newest = ch.query(f"SELECT max(_kafka_metadata_timestamp) FROM {source}").result_rows[0][0]
    needed = end + dt.timedelta(days=SETTLED_DAYS)
    if newest is None or newest.date() < needed:
        raise ValueError(f"the lake is behind: its newest event arrived {newest}, and {end} needs events from {needed} on")


def recompute(ch, source: str, database: str, scratch: str, start: dt.date, end: dt.date, tenants: list[str]) -> None:
    """Creates the scratch database and fills its daily tables for the days, from the lake."""
    ch.command(f"DROP DATABASE IF EXISTS {scratch} SYNC")
    for file in ("01_tables.sql", "02_materialized_views.sql"):
        for statement in statements(file, scratch):
            # The hourly check: recomputed days are exact already.
            if "REFRESH EVERY" not in statement:
                ch.command(statement)
    valid = lambda before, after: VALID.format(  # noqa: E731
        parsed=PARSED.format(source=source, no_store=NO_STORE, before=before, after=after), database=database)
    for day in days(start, end):
        params = {"day": day, "tenants": tenants}
        ch.command(EVENTS.format(scratch=scratch, valid=valid(1, 3)), parameters=params)
        # The clicks of the 7 days before, and the day's baskets, arrive between 8 days before and 3 after.
        ch.command(ATTRIBUTED.format(scratch=scratch, valid=valid(8, 3)), parameters=params)
        # The day before to the day after, which arrive between 2 days before and 4 after.
        ch.command(SESSIONS.format(scratch=scratch, valid=valid(2, 4)), parameters=params)


def pause(ch, database: str) -> None:
    """Stops ClickHouse reading Kafka and the hourly check, so the daily tables don't change while they're swapped."""
    existing = tables_in(ch, database)
    for view in QUEUE_VIEWS:
        if view in existing:
            ch.command(f"DETACH TABLE {database}.{view}")
    for view in CHECK_VIEWS:
        if view in existing:
            ch.command(f"SYSTEM STOP VIEW {database}.{view}")
            ch.command(f"SYSTEM CANCEL VIEW {database}.{view}")


def resume(ch, database: str) -> None:
    detached = {row[0] for row in ch.query("SELECT table FROM system.detached_tables WHERE database = {db:String}", parameters={"db": database}).result_rows}
    for view in QUEUE_VIEWS:
        if view in detached:
            # A view detached moments ago can still be held by its last Kafka read ("still used by
            # some query"): a short swap would leave ClickHouse not reading Kafka, so wait for it.
            for attempt in range(30):
                try:
                    ch.command(f"ATTACH TABLE {database}.{view}")
                    break
                except Exception as error:
                    if "still used by some query" not in str(error) or attempt == 29:
                        raise
                    time.sleep(2)
    existing = tables_in(ch, database)
    for view in CHECK_VIEWS:
        if view in existing:
            ch.command(f"SYSTEM START VIEW {database}.{view}")


def swap(ch, database: str, scratch: str, tables: list[str], start: dt.date, end: dt.date, tenants: list[str]) -> None:
    """Replaces each month of the days in each table with the scratch one, keeping the replaced one."""
    months = sorted({day.strftime("%Y%m") for day in days(start, end)})
    params = {"start": start, "end": end, "tenants": tenants}
    recomputed = "day BETWEEN {start:Date} AND {end:Date} AND (empty({tenants:Array(UUID)}) OR has({tenants:Array(UUID)}, tenant_id))"
    pause(ch, database)
    try:
        for table in tables:
            ch.command(f"CREATE TABLE {scratch}.previous_{table} AS {database}.{table}")
            for month in months:
                # The month's other days and tenants, as they are.
                ch.command(f"INSERT INTO {scratch}.{table} SELECT * FROM {database}.{table} WHERE toYYYYMM(day) = {month} AND NOT ({recomputed})", parameters=params)
                ch.command(f"ALTER TABLE {scratch}.previous_{table} REPLACE PARTITION ID '{month}' FROM {database}.{table}")
                ch.command(f"ALTER TABLE {database}.{table} REPLACE PARTITION ID '{month}' FROM {scratch}.{table}")
    finally:
        resume(ch, database)


def backfill(ch, source: str, start: dt.date, end: dt.date, tenants: list[str], tables: list[str] | None = None,
             database: str = "analytics", scratch: str = "analytics_backfill", today: dt.date | None = None,
             lake_caught_up: bool = False) -> dict[str, int]:
    """Recomputes the days (of the tenants, or all) in the daily tables (or all); the recomputed rows per table.
    lake_caught_up: refuse unless the lake holds every event that can still arrive for the days."""
    started = dt.datetime.now(dt.UTC)
    check_range(ch, source, start, end, today or started.date())
    if lake_caught_up:
        check_lake_caught_up(ch, source, end)
    recompute(ch, source, database, scratch, start, end, tenants)
    daily = sorted(name for name in tables_in(ch, scratch) if name.startswith("daily_") and not name.endswith("_mv"))
    unknown = set(tables or []) - set(daily)
    if unknown:
        raise ValueError(f"no such daily table: {', '.join(sorted(unknown))} (they are {', '.join(daily)})")
    chosen = tables or daily
    rows = {table: ch.query(f"SELECT count() FROM {scratch}.{table}").result_rows[0][0] for table in chosen}
    swap(ch, database, scratch, chosen, start, end, tenants)
    ch.insert(f"{database}.backfill_runs", [[uuid.uuid4(), started, dt.datetime.now(dt.UTC), start, end, tenants, chosen, rows]],
              column_names=["run_id", "started_at", "finished_at", "from_day", "to_day", "tenants", "tables", "rows"])
    return rows


def rollback(ch, database: str = "analytics", scratch: str = "analytics_backfill") -> str:
    """Puts back the months the latest backfill replaced, as they were before it. The
    scratch database holds only the latest run's, so an older run can't be rolled back."""
    runs = ch.query(f"SELECT toString(run_id), from_day, to_day, tables, rolled_back FROM {database}.backfill_runs ORDER BY started_at DESC LIMIT 1").result_rows
    if not runs or not any(name.startswith("previous_") for name in tables_in(ch, scratch)):
        raise ValueError("nothing to roll back: no backfill has run")
    run_id, start, end, tables, rolled_back = runs[0]
    if rolled_back:
        raise ValueError(f"the latest backfill ({run_id}) is rolled back already")
    months = sorted({day.strftime("%Y%m") for day in days(start, end)})
    pause(ch, database)
    try:
        for table in tables:
            for month in months:
                ch.command(f"ALTER TABLE {database}.{table} REPLACE PARTITION ID '{month}' FROM {scratch}.previous_{table}")
    finally:
        resume(ch, database)
    ch.command(f"ALTER TABLE {database}.backfill_runs UPDATE rolled_back = true WHERE run_id = {{run:UUID}}",
               parameters={"run": run_id}, settings={"mutations_sync": 2})
    return run_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from", dest="start", type=dt.date.fromisoformat)
    parser.add_argument("--to", dest="end", type=dt.date.fromisoformat)
    parser.add_argument("--tenant", dest="tenants", action="append", default=[], help="only this tenant's rows (repeatable)")
    parser.add_argument("--table", dest="tables", action="append", help="only this daily table (repeatable), e.g. a new one")
    parser.add_argument("--rollback", action="store_true", help="undo the latest backfill")
    parser.add_argument("--only-if-lake-caught-up", dest="lake_caught_up", action="store_true",
                        help="refuse while the lake may still lack events of the days (scheduled runs)")
    args = parser.parse_args()
    # Long scans of the lake, and whole months copied.
    ch = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"], send_receive_timeout=3600)
    if args.rollback:
        print(f"rolled back backfill {rollback(ch)}")
        return
    if not (args.start and args.end):
        parser.error("--from and --to are required (or --rollback)")
    source = lake_source(os.environ["LAKE_INTERACTIONS_URL"],
                         os.environ.get("PYICEBERG_CATALOG__LAKE__S3__ACCESS_KEY_ID"),
                         os.environ.get("PYICEBERG_CATALOG__LAKE__S3__SECRET_ACCESS_KEY"))
    rows = backfill(ch, source, args.start, args.end, [tenant.lower() for tenant in args.tenants], args.tables, lake_caught_up=args.lake_caught_up)
    print(f"recomputed {args.start} to {args.end}{' for ' + ', '.join(args.tenants) if args.tenants else ''}: {rows}")


if __name__ == "__main__":
    main()
