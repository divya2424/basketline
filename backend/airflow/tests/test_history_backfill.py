"""The history backfill (jobs/backfill) end to end, in Spark local mode: raw events
in the Iceberg archive → Spark → ClickHouse staging → swap. Runs in the Airflow
container, which has Java (npm run test:backfill):

    docker compose up -d --build clickhouse postgres archive-storage airflow
    npm run test:backfill

It writes to the archive_test and backfill_test namespaces and a throwaway
ClickHouse database, so the real archive and analytics tables are untouched.
"""

import datetime as dt
import json
import os
import re
import sys
import threading
import uuid
from pathlib import Path

import pyarrow as pa
import pytest

DATABASE = f"backfill_test_{uuid.uuid4().hex[:8]}"
CLICKHOUSE = os.environ["CLICKHOUSE_URL"].rsplit("/", 1)[0]
os.environ["CLICKHOUSE_URL"] = f"{CLICKHOUSE}/{DATABASE}"
os.environ["ARCHIVE_NAMESPACE"] = "archive_test"
os.environ["BACKFILL_NAMESPACE"] = "backfill_test"

import clickhouse_connect  # noqa: E402
from pyiceberg.catalog import load_catalog  # noqa: E402
from pyiceberg.expressions import EqualTo, LessThan  # noqa: E402

JOBS = Path(__file__).parents[1] / "jobs"
sys.path[:0] = [str(JOBS), str(JOBS / "backfill")]
import load_backfill as load  # noqa: E402
import spark_backfill  # noqa: E402
from export_archive import iceberg_table  # noqa: E402

# The schema without its Kafka tables (03_kafka.sql), so the test database consumes no topics.
SCHEMA_DIR = Path(os.environ.get("CLICKHOUSE_SCHEMA_DIR", "/opt/airflow/clickhouse"))
SCHEMA_FILES = ["00_functions.sql", "01_tables.sql", "02_materialized_views.sql"]
CASES = json.loads((Path(__file__).parent / "fixtures" / "attribution_cases.json").read_text())["cases"]
# The attribution cases' reference time; every month here is long closed.
REF = dt.datetime(2026, 8, 10, 12, tzinfo=dt.UTC)
T1, T2 = str(uuid.uuid4()), str(uuid.uuid4())
AUGUST = 202608


def at(hours: float) -> dt.datetime:
    return REF + dt.timedelta(hours=hours)


def event(tenant: str, name: str, time: dt.datetime, **extra) -> dict:
    return {"event_id": str(uuid.uuid4()), "event_name": name, "tenant_id": tenant, "properties": "{}", "event_time": time,
            "received_at": time, "ingested_at": time, "client_type": "web", "user_type": "visitor", **extra}


def attribution_events():
    """The shared cases as archive rows, each with its own user, products and campaigns; and the expected campaign per case."""
    rows, expected = [], []
    for case in CASES:
        names = {"U": str(uuid.uuid4()), "V": str(uuid.uuid4()), "P": str(uuid.uuid4()), "Q": str(uuid.uuid4()),
                 "A": str(uuid.uuid4()), "B": str(uuid.uuid4()), "T": T1, "O": T2}
        campaign_of = {}
        for e in case["events"]:
            product = e.get("product", "P")
            row = event(names[e.get("tenant", "T")], e["event"], at(e["at"]), user_id=names[e.get("user", "U")],
                        user_type=e.get("userType", "visitor"), product_id=names[product] if product else None,
                        campaign_id=names[e["campaign"]] if "campaign" in e else None)
            campaign_of[e["id"]] = row["campaign_id"]
            rows.append(row)
        for basket, click in case["credits"].items():
            basket_day = at(next(e["at"] for e in case["events"] if e["id"] == basket)).date()
            expected.append((case["name"], basket_day, [names["A"], names["B"]], campaign_of[click] if click else None))
    return rows, expected


@pytest.fixture(scope="module")
def ch():
    admin = clickhouse_connect.get_client(dsn=CLICKHOUSE)
    schema = re.sub(r"--.*$", "", "\n".join((SCHEMA_DIR / name).read_text() for name in SCHEMA_FILES), flags=re.M)
    for statement in filter(None, (s.strip() for s in re.sub(r"\banalytics\b", DATABASE, schema).split(";"))):
        admin.command(statement)
    client = load.client()
    yield client
    admin.command(f"DROP DATABASE IF EXISTS {DATABASE}")


@pytest.fixture(scope="module")
def spark():
    session = spark_backfill.spark_session()
    yield session
    session.stop()


@pytest.fixture(scope="module")
def archive():
    """Archive rows for July and August 2026: the attribution cases, a session, and other tenants' events."""
    table = iceberg_table(load_catalog("archive"), "archive_test", "events")
    # Earlier runs' rows (the export test only writes recent days).
    table.delete(LessThan("event_time", "2026-10-01T00:00:00+00:00"))
    rows, expected = attribution_events()
    shopper, campaign, product = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    morning = dt.datetime(2026, 8, 12, 10, tzinfo=dt.UTC)
    rows += [
        # Two sessions of one shopper, 8 hours apart; the first converts for its campaign.
        event(T1, "impression", morning, user_id=shopper, campaign_id=campaign),
        event(T1, "click", morning + dt.timedelta(minutes=10), user_id=shopper, campaign_id=campaign, product_id=product),
        event(T1, "add_to_cart", morning + dt.timedelta(minutes=20), user_id=shopper, product_id=product),
        event(T1, "home_view", morning + dt.timedelta(hours=8, minutes=20), user_id=shopper),
        # The other tenant: 2 impressions on 5 August, 1 on 3 July.
        *[event(T2, "impression", dt.datetime(2026, 8, 5, 9, tzinfo=dt.UTC), user_id=str(uuid.uuid4()), campaign_id=campaign) for _ in range(2)],
        event(T2, "impression", dt.datetime(2026, 7, 3, 9, tzinfo=dt.UTC), user_id=str(uuid.uuid4()), campaign_id=campaign),
        # Context: the archive starts more than 7 days before every range here.
        event(str(uuid.uuid4()), "home_view", dt.datetime(2026, 6, 1, tzinfo=dt.UTC)),
    ]
    target = table.schema().as_arrow()
    table.append(pa.Table.from_pylist([{f.name: r.get(f.name) for f in target} for r in rows], schema=target))
    return {"expected": expected, "session_campaign": campaign}


def seed_live(ch, campaign: str):
    """What the daily tables hold before the backfill: T1 too high on 5 August, T1 on 20 August (outside the
    first run's range), and T2 on 5 August (outside its tenant scope)."""
    ch.command(f"""INSERT INTO daily_campaign_aggregation (day, tenant_id, campaign_id, total_impressions, total_web_impressions)
                   VALUES ('2026-08-05', '{T1}', '{campaign}', 100, 100), ('2026-08-20', '{T1}', '{campaign}', 7, 7),
                          ('2026-08-05', '{T2}', '{campaign}', 5, 5)""")
    ch.command(f"""INSERT INTO daily_campaign_customers_aggregation (day, tenant_id, campaign_id, has_visited)
                   SELECT toDate('2026-08-20'), toUUID('{T1}'), toUUID('{campaign}'), uniqCombined64State(generateUUIDv4())""")


def totals(ch, tenant: str, day: str | None = None, month: int = AUGUST) -> dict:
    """Per campaign: impressions, click-to-basket, customers who added to the cart (registered), sessions and converted."""
    where = f"tenant_id = '{tenant}' AND toYYYYMM(day) = {month}" + (f" AND day = '{day}'" if day else "")
    result = {}
    for c, i, b in ch.query(f"SELECT toString(campaign_id), sum(total_impressions), sum(total_click_to_basket) FROM daily_campaign_aggregation WHERE {where} GROUP BY campaign_id").result_rows:
        result.setdefault(c, {}).update(impressions=i, baskets=b)
    for c, v, cb, reg in ch.query(f"""SELECT toString(campaign_id), uniqCombined64Merge(has_visited), uniqCombined64Merge(customers_click_to_basket),
                                             uniqCombined64Merge(customers_registered_click_to_basket)
                                      FROM daily_campaign_customers_aggregation WHERE {where} GROUP BY campaign_id""").result_rows:
        result.setdefault(c, {}).update(visited=v, basket_customers=cb, registered_basket_customers=reg)
    for c, s, conv, avg in ch.query(f"""SELECT toString(campaign_id), uniqCombined64Merge(total_sessions), uniqCombined64Merge(total_converted_sessions),
                                               avgMerge(avg_session_duration_ms)
                                        FROM daily_campaign_sessions_aggregation WHERE {where} GROUP BY campaign_id""").result_rows:
        result.setdefault(c, {}).update(sessions=s, converted=conv, avg_ms=avg)
    return result


def run(ch, spark, run_id, start, end, tenants):
    load.validate(ch, run_id, start, end, tenants)
    spark_backfill.backfill(spark, run_id, start, end, tenants, allow_partial_context=False)
    load.prepare(ch, run_id)
    load.check(ch, run_id)


def test_refuses_a_month_that_isnt_closed(ch):
    today = dt.datetime.now(dt.UTC).date()
    with pytest.raises(SystemExit, match="isn't closed"):
        load.validate(ch, "open", today - dt.timedelta(days=3), today, None)


def test_backfills_one_tenant_then_all(ch, spark, archive):
    campaign = archive["session_campaign"]
    seed_live(ch, campaign)
    before_t1, before_t2 = totals(ch, T1), totals(ch, T2)

    # One tenant, the first half of August. Prepared and checked: nothing live has changed.
    run(ch, spark, "one_tenant", dt.date(2026, 8, 1), dt.date(2026, 8, 16), [T1])
    assert totals(ch, T1) == before_t1 and totals(ch, T2) == before_t2

    # Swap, while a dashboard reads the month: every answer is the old month or the new one.
    seen, stop = set(), threading.Event()

    def read():
        reader = load.client()
        while not stop.is_set():
            seen.add(reader.query(f"SELECT sum(total_impressions) FROM daily_campaign_aggregation WHERE tenant_id = '{T1}' AND toYYYYMM(day) = {AUGUST}").result_rows[0][0])

    thread = threading.Thread(target=read)
    thread.start()
    load.swap(ch, "one_tenant")
    stop.set()
    thread.join()
    after_t1 = totals(ch, T1)
    old, new = before_t1[campaign]["impressions"], after_t1[campaign]["impressions"]
    assert seen <= {old, new}, seen

    # The inflated day is exact now (1 impression, from the session), and the day outside the range kept its 7.
    assert totals(ch, T1, "2026-08-05").get(campaign, {}).get("impressions", 0) == 0
    assert totals(ch, T1, "2026-08-12")[campaign]["impressions"] == 1
    assert totals(ch, T1, "2026-08-20")[campaign]["impressions"] == 7
    assert totals(ch, T1, "2026-08-20")[campaign]["visited"] == 1
    # The other tenant is untouched.
    assert totals(ch, T2) == before_t2

    # Attribution: the same cases as the Flink test, the same winners.
    for name, day, campaigns, winner in archive["expected"]:
        if day >= dt.date(2026, 8, 16):
            continue
        day_totals = totals(ch, T1, day.isoformat())
        credited = {c: day_totals.get(c, {}).get("baskets", 0) for c in campaigns}
        assert credited == {c: int(c == winner) for c in campaigns}, name
        if winner:
            assert day_totals[winner]["basket_customers"] == 1, name
    registered = next(e for e in archive["expected"] if e[0].startswith("clicked as a visitor"))
    assert totals(ch, T1, registered[1].isoformat())[registered[3]]["registered_basket_customers"] == 1

    # Sessions: two, 8 hours apart; the first saw the campaign, converted, and lasted 20 minutes.
    session = totals(ch, T1, "2026-08-12")[campaign]
    assert (session["sessions"], session["converted"], session["avg_ms"]) == (1, 1, 20 * 60_000)

    # The run's Iceberg rows are gone, and a rollback puts the old month back.
    for name in ["event_totals", "customer_days", "sessions"]:
        rows = load_catalog("archive").load_table(f"backfill_test.{name}").scan(row_filter=EqualTo("run_id", "one_tenant")).to_arrow()
        assert rows.num_rows == 0, name
    load.rollback(ch, "one_tenant")
    assert totals(ch, T1) == before_t1

    # All tenants, July and August, prepared together: a failure in the middle of the swap undoes it.
    run(ch, spark, "all_tenants", dt.date(2026, 7, 1), dt.date(2026, 9, 1), None)
    ch.command("DROP TABLE daily_campaign_sessions_aggregation_rebuild")
    with pytest.raises(Exception):
        load.swap(ch, "all_tenants")
    assert totals(ch, T1) == before_t1 and totals(ch, T2) == before_t2

    # Prepared again, swapped: both tenants, both months, all three tables.
    load.prepare(ch, "all_tenants")
    load.check(ch, "all_tenants")
    load.swap(ch, "all_tenants")
    assert totals(ch, T2, "2026-08-05")[campaign]["impressions"] == 2
    assert totals(ch, T2, month=202607)[campaign]["impressions"] == 1
    assert totals(ch, T1, "2026-08-12")[campaign]["sessions"] == 1
    # The whole month was in scope this time: 20 August has no archived events, so it is empty now.
    assert campaign not in totals(ch, T1, "2026-08-20")
