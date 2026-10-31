"""Loads a backfill run (spark_backfill.py) into ClickHouse's daily tables:
everything is prepared first, then swapped at the end.

    load_backfill.py validate --run-id R --from 2026-08-01 --to 2026-09-01 [--tenants all|<uuid>,...]
    load_backfill.py prepare  --run-id R   # staging + backup + report; nothing live changes
    load_backfill.py check    --run-id R
    load_backfill.py swap     --run-id R   # every table and month, back to back
    load_backfill.py rollback --run-id R   # the months of the latest run back from the backup

Per daily table T (TABLES) and touched month M:
  T_rebuild         staging: M's live rows outside the run's scope (other
                    tenants, other days) as they are, plus the recomputed rows
  T_before_rebuild  the live partition before the swap, for rollback

The daily tables are partitioned by month (infra/clickhouse/01_tables.sql), and
ALTER TABLE T REPLACE PARTITION M FROM T_rebuild swaps a month's parts
atomically: a query sees the whole old month or the whole new one, never a
missing or partial month. Only closed months are touched (their last day is
more than 7 days ago: events arrive at most 5 days late, plus two days' margin
for the archive's last commits), so no live view or hourly check writes to them.

The recomputed rows are read from the run's Iceberg tables with icebergS3, and
the sketches are built here, with the same functions and types as the live
views, so they merge with live rows.
"""

import argparse
import datetime as dt
import os
import sys
from pathlib import Path

import clickhouse_connect
from pyiceberg.catalog import load_catalog
from pyiceberg.expressions import EqualTo

sys.path.insert(0, str(Path(__file__).parent))
from spark_backfill import namespace, parse_tenants, run_name  # noqa: E402

TABLES = ["daily_campaign_aggregation", "daily_campaign_customers_aggregation", "daily_campaign_sessions_aggregation"]
# Days events may still arrive for (analytics-service's 5 days), plus two days' margin for the archive's last commits.
LATE_DAYS = 7
# The backfill's own limits, so it can't starve the queries dashboards make.
SETTINGS = {
    "max_threads": int(os.environ.get("BACKFILL_MAX_THREADS", "4")),
    "max_memory_usage": int(os.environ.get("BACKFILL_MAX_MEMORY_BYTES", str(4 * 1024**3))),
}
RUNS = """CREATE TABLE IF NOT EXISTS backfill_runs
(
    run_id     String,
    day_from   Date,
    day_to     Date,
    tenants    Array(UUID),     -- empty: all tenants
    months     Array(UInt32),   -- the partitions it touches (YYYYMM)
    status     LowCardinality(String),
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY run_id"""
RUN_COLUMNS = ["run_id", "day_from", "day_to", "tenants", "months", "status"]


def client():
    return clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"], settings=SETTINGS)


def months(start: dt.date, end: dt.date) -> list[int]:
    """The YYYYMM partitions of the days in [start, end)."""
    found, day = [], start.replace(day=1)
    while day < end:
        found.append(day.year * 100 + day.month)
        day = (day.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return found


def first_open_day(today: dt.date | None = None) -> dt.date:
    """Months ending before this day are closed."""
    return (today or dt.datetime.now(dt.UTC).date()) - dt.timedelta(days=LATE_DAYS)


def validate(ch, run_id: str, start: dt.date, end: dt.date, tenants: list[str] | None, today: dt.date | None = None):
    if start >= end:
        raise SystemExit("--from must be before --to")
    touched = months(start, end)
    last = touched[-1]
    month_end = dt.date(last // 100 + (last % 100) // 12, last % 100 % 12 + 1, 1)
    if month_end > first_open_day(today):
        raise SystemExit(f"{last // 100}-{last % 100:02d} isn't closed yet: a month can be backfilled once its last day is more than {LATE_DAYS} days ago")
    ch.command(RUNS)
    ch.insert("backfill_runs", [[run_id, start, end, tenants or [], touched, "validated"]], column_names=RUN_COLUMNS)
    print(f"run {run_id}: {start} to {end}, {'all tenants' if not tenants else ', '.join(tenants)}, months {touched}")


def run(ch, run_id: str) -> dict:
    rows = ch.query("SELECT day_from, day_to, arrayMap(t -> toString(t), tenants), months, status FROM backfill_runs FINAL WHERE run_id = {r:String}",
                    parameters={"r": run_id}).result_rows
    if not rows:
        raise SystemExit(f"no backfill run {run_id}: run validate first")
    start, end, tenants, touched, status = rows[0]
    return {"start": start, "end": end, "tenants": list(tenants), "months": list(touched), "status": status}


def set_status(ch, run_id: str, status: str):
    r = run(ch, run_id)
    ch.insert("backfill_runs", [[run_id, r["start"], r["end"], r["tenants"], r["months"], status]], column_names=RUN_COLUMNS)


def scope(r: dict) -> str:
    """The rows this run recomputes: its days, and its tenants if not all."""
    tenants = f" AND tenant_id IN ({', '.join(f'toUUID({t!r})' for t in r['tenants'])})" if r["tenants"] else ""
    return f"(day >= toDate('{r['start']}') AND day < toDate('{r['end']}'){tenants})"


def source(name: str) -> tuple[str, dict]:
    """The run's Iceberg table `name` for ClickHouse, and the query settings that pin its current snapshot."""
    ns = namespace()
    metadata = load_catalog("archive").load_table(f"{ns}.{name}").metadata_location
    table_path = metadata.split("/metadata/")[0]
    url = f"{os.environ['ARCHIVE_S3_URL'].rstrip('/')}/{ns}/{name}"
    key, secret = os.environ.get("PYICEBERG_CATALOG__ARCHIVE__S3__ACCESS_KEY_ID"), os.environ.get("PYICEBERG_CATALOG__ARCHIVE__S3__SECRET_ACCESS_KEY")
    credentials = f", '{key}', '{secret}'" if key else ""  # On AWS: ClickHouse's IAM role.
    # The metadata file the catalog points to, not whichever ClickHouse finds newest
    # (a dropped table's files can remain at the same path). A table setting since
    # ClickHouse 26, not a query setting.
    return f"icebergS3('{url}'{credentials}, SETTINGS iceberg_metadata_file_path = '{metadata[len(table_path) + 1:]}')", {}


def customers_states(user: str, metric: str, client_type: str, user_type: str) -> str:
    """The customer sketch columns, built as the live views build them (daily_campaign_customers_aggregation)."""
    splits = [("", "1"), ("web_", f"{client_type} = 'web'"), ("mobile_", f"{client_type} = 'mobile'"),
              ("registered_", f"{user_type} = 'registered'"), ("visitor_", f"{user_type} = 'visitor'")]
    visited = [("has_visited", "1"), ("has_visited_in_web", f"{client_type} = 'web'"), ("has_visited_in_mobile", f"{client_type} = 'mobile'"),
               ("has_visited_registered", f"{user_type} = 'registered'"), ("has_visited_visitor", f"{user_type} = 'visitor'")]
    states = [f"uniqCombined64StateIf({user}, {metric} IN ('impression', 'click') AND {cond}) AS {name}" for name, cond in visited]
    for name, event in [("impressions", "impression"), ("clicks", "click"), ("click_to_basket", "click_to_basket")]:
        states += [f"uniqCombined64StateIf({user}, {metric} = '{event}' AND {cond}) AS customers_{split}{name}" for split, cond in splits]
    return ",\n               ".join(states)


def recomputed(run_id: str, month: int) -> dict[str, tuple[str, dict]]:
    """Per daily table, the SELECT of the run's recomputed rows for one month (in
    the table's column order) and the settings it needs."""
    where = f"run_id = '{run_id}' AND toYYYYMM(day) = {month}"
    totals, totals_settings = source("event_totals")
    customer_days, customers_settings = source("customer_days")
    sessions, sessions_settings = source("sessions")
    return {
        "daily_campaign_aggregation": (f"""
            SELECT toDate(day), toUUID(tenant_id), toUUID(campaign_id),
                   total_impressions, total_web_impressions, total_mobile_impressions,
                   total_clicks, total_web_clicks, total_mobile_clicks,
                   total_click_to_basket, total_web_click_to_basket, total_mobile_click_to_basket
            FROM {totals} WHERE {where}""", totals_settings),
        "daily_campaign_customers_aggregation": (f"""
            SELECT d, tid, cid,
               {customers_states('uid', 'metric', 'client_type', 'user_type')}
            FROM (SELECT toDate(day) AS d, toUUID(tenant_id) AS tid, toUUID(campaign_id) AS cid, assumeNotNull(toUUID(user_id)) AS uid, metric, client_type, user_type
                  FROM {customer_days} WHERE {where})
            GROUP BY d, tid, cid""", customers_settings),
        # As daily_campaign_sessions_aggregation_mv; session_id from sessionId (00_functions.sql), as 03_kafka.sql.
        # Iceberg columns read as Nullable, and a sketch's type includes its argument's,
        # so the IDs and times it aggregates are made non-Nullable to merge with live rows.
        "daily_campaign_sessions_aggregation": (f"""
            SELECT toDate(start) AS d, tid, toUUID(campaign) AS cid,
                   uniqCombined64State(sid),
                   uniqCombined64StateIf(sid, arrayExists(pair -> splitByChar(':', assumeNotNull(pair))[1] = campaign
                                                              AND has(added, splitByChar(':', assumeNotNull(pair))[2]), clicked)),
                   avgState(toInt64(dateDiff('millisecond', start, last)))
            FROM (SELECT toUUID(tenant_id) AS tid, assumeNotNull(toDateTime64(session_start, 3, 'UTC')) AS start, assumeNotNull(toDateTime64(last_event_time, 3, 'UTC')) AS last,
                         campaigns, clicked, added,
                         assumeNotNull(sessionId(toUUID(tenant_id), toUUID(user_id), toDateTime64(session_start, 3, 'UTC'))) AS sid
                  FROM {sessions} WHERE {where})
            ARRAY JOIN campaigns AS campaign
            GROUP BY d, tid, cid""", sessions_settings),
    }


def report(ch, r: dict) -> list[tuple]:
    """Per tenant, day and table in the run's scope: the live value and the staged one."""
    measures = {
        "daily_campaign_aggregation": "sum(total_impressions + total_clicks + total_click_to_basket)",
        "daily_campaign_customers_aggregation": "uniqCombined64Merge(has_visited)",
        "daily_campaign_sessions_aggregation": "uniqCombined64Merge(total_sessions)",
    }
    rows = []
    for table, measure in measures.items():
        rows += ch.query(f"""
            SELECT '{table}', toString(tenant_id), day, sumIf(v, src = 'live'), sumIf(v, src = 'staged')
            FROM (SELECT 'live' AS src, tenant_id, day, {measure} AS v FROM {table} WHERE {scope(r)} GROUP BY tenant_id, day
                  UNION ALL
                  SELECT 'staged', tenant_id, day, {measure} FROM {table}_rebuild WHERE {scope(r)} GROUP BY tenant_id, day)
            GROUP BY tenant_id, day ORDER BY tenant_id, day""").result_rows
    for table, tenant, day, live, staged in rows:
        print(f"{table:40} {tenant} {day}  {live:>10} -> {staged:<10}{'' if live == staged else '  changed'}")
    return rows


def prepare(ch, run_id: str):
    r = run(ch, run_id)
    for table in TABLES:
        ch.command(f"CREATE TABLE IF NOT EXISTS {table}_rebuild AS {table}")
        ch.command(f"CREATE TABLE IF NOT EXISTS {table}_before_rebuild AS {table}")
        ch.command(f"TRUNCATE TABLE {table}_rebuild")
    for month in r["months"]:
        selects = recomputed(run_id, month)
        for table in TABLES:
            # Everything outside the scope as it is: other tenants, and the scope's other days.
            ch.command(f"INSERT INTO {table}_rebuild SELECT * FROM {table} WHERE toYYYYMM(day) = {month} AND NOT {scope(r)}")
            select, settings = selects[table]
            ch.command(f"INSERT INTO {table}_rebuild {select}", settings=settings)
            # What the swap will replace, kept for rollback.
            ch.command(f"ALTER TABLE {table}_before_rebuild REPLACE PARTITION ID '{month}' FROM {table}")
    set_status(ch, run_id, "prepared")
    report(ch, r)


def check(ch, run_id: str):
    r = run(ch, run_id)
    if r["status"] != "prepared":
        raise SystemExit(f"run {run_id} is {r['status']}, not prepared")
    for table in TABLES:
        for month in r["months"]:
            counts = ch.query(f"""
                SELECT (SELECT count() FROM {table} WHERE toYYYYMM(day) = {month} AND NOT {scope(r)}),
                       (SELECT count() FROM {table}_rebuild WHERE toYYYYMM(day) = {month} AND NOT {scope(r)}),
                       (SELECT count() FROM {table} WHERE toYYYYMM(day) = {month}),
                       (SELECT count() FROM {table}_before_rebuild WHERE toYYYYMM(day) = {month})""").result_rows[0]
            outside_live, outside_staged, live, backup = counts
            if outside_live != outside_staged or live != backup:
                raise SystemExit(f"{table} {month}: rows outside the scope {outside_live} live vs {outside_staged} staged, "
                                 f"{live} live vs {backup} backed up: prepare again")
    set_status(ch, run_id, "checked")
    print(f"run {run_id} checked: {len(TABLES)} tables x {len(r['months'])} months")


def swap(ch, run_id: str):
    """Every table and month, back to back; if one fails, those already swapped go back."""
    r = run(ch, run_id)
    if r["status"] != "checked":
        raise SystemExit(f"run {run_id} is {r['status']}, not checked")
    done = []
    try:
        for table in TABLES:
            for month in r["months"]:
                ch.command(f"ALTER TABLE {table} REPLACE PARTITION ID '{month}' FROM {table}_rebuild")
                done.append((table, month))
    except Exception:
        for table, month in reversed(done):
            ch.command(f"ALTER TABLE {table} REPLACE PARTITION ID '{month}' FROM {table}_before_rebuild")
        set_status(ch, run_id, "swap failed, rolled back")
        raise
    set_status(ch, run_id, "swapped")
    print(f"run {run_id} swapped: {len(done)} partitions")
    cleanup(run_id)


def rollback(ch, run_id: str):
    r = run(ch, run_id)
    later = ch.query("""SELECT run_id FROM backfill_runs FINAL
                        WHERE updated_at > (SELECT max(updated_at) FROM backfill_runs WHERE run_id = {r:String})
                          AND status IN ('prepared', 'checked', 'swapped') AND hasAny(months, {m:Array(UInt32)})""",
                     parameters={"r": run_id, "m": r["months"]}).result_rows
    if later:
        raise SystemExit(f"run {later[0][0]} prepared the same months later, so the backup no longer holds what {run_id} replaced")
    for table in TABLES:
        for month in r["months"]:
            ch.command(f"ALTER TABLE {table} REPLACE PARTITION ID '{month}' FROM {table}_before_rebuild")
    set_status(ch, run_id, "rolled back")
    print(f"run {run_id} rolled back")


def cleanup(run_id: str):
    """Deletes the run's rows from the Iceberg backfill tables; the swapped data lives in ClickHouse now."""
    catalog = load_catalog("archive")
    for name in ["event_totals", "customer_days", "sessions"]:
        catalog.load_table(f"{namespace()}.{name}").delete(EqualTo("run_id", run_id))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("step", choices=["validate", "prepare", "check", "swap", "rollback"])
    parser.add_argument("--run-id", required=True, type=run_name)
    parser.add_argument("--from", dest="start", type=dt.date.fromisoformat)
    parser.add_argument("--to", dest="end", type=dt.date.fromisoformat)
    parser.add_argument("--tenants", default="all", type=parse_tenants)
    args = parser.parse_args()
    ch = client()
    if args.step == "validate":
        if not args.start or not args.end:
            parser.error("validate needs --from and --to")
        validate(ch, args.run_id, args.start, args.end, args.tenants)
    else:
        {"prepare": prepare, "check": check, "swap": swap, "rollback": rollback}[args.step](ch, args.run_id)
