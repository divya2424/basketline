"""The history backfill against the running stack's ClickHouse, Postgres catalog and S3:

    docker compose up -d clickhouse postgres archive-storage
    pnpm test:airflow

A lake_test.interactions table, shaped like the one Kafka Connect writes, stands
in for the lake; analytics is a throwaway ClickHouse database with the real schema.
The attribution cases are the Flink test's (basketline/test/fixtures), so the
backfill credits basket additions as the Flink job does.
"""

import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path

BASKETLINE = Path(__file__).parents[2]
# Before importing PyIceberg, which reads its configuration from the environment then.
for name, value in {
    "PYICEBERG_CATALOG__LAKE__TYPE": "sql",
    "PYICEBERG_CATALOG__LAKE__URI": "postgresql+psycopg2://iceberg_svc:iceberg_svc_dev@localhost:5432/iceberg_catalog_db",
    "PYICEBERG_CATALOG__LAKE__WAREHOUSE": "s3://basketline-pipeline",
    "PYICEBERG_CATALOG__LAKE__S3__ENDPOINT": "http://localhost:8333",
    "PYICEBERG_CATALOG__LAKE__S3__REGION": "us-east-1",
    "PYICEBERG_CATALOG__LAKE__S3__ACCESS_KEY_ID": "archive",
    "PYICEBERG_CATALOG__LAKE__S3__SECRET_ACCESS_KEY": "archive_dev",
    "CLICKHOUSE_SCHEMA_DIR": str(BASKETLINE / "infra/clickhouse"),
}.items():
    os.environ.setdefault(name, value)

import clickhouse_connect  # noqa: E402
import pyarrow as pa  # noqa: E402
import pytest  # noqa: E402
from pyiceberg.catalog import load_catalog  # noqa: E402
from pyiceberg.partitioning import PartitionField, PartitionSpec  # noqa: E402
from pyiceberg.schema import Schema  # noqa: E402
from pyiceberg.transforms import HourTransform, IdentityTransform  # noqa: E402
from pyiceberg.types import LongType, NestedField, StringType, TimestamptzType  # noqa: E402

sys.path.insert(0, str(BASKETLINE / "airflow/jobs"))
import backfill_daily as job  # noqa: E402

# As ClickHouse reaches the lake.
SOURCE = job.lake_source("http://archive-storage:8333/basketline-pipeline/lake_test/interactions/", "archive", "archive_dev")
TODAY = dt.datetime.now(dt.UTC).date()
DAY = TODAY - dt.timedelta(days=10)
NOON = dt.datetime.combine(DAY, dt.time(12), dt.UTC)
TENANT, OTHER, STORE = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
CASES = json.loads((BASKETLINE / "test/fixtures/attribution_cases.json").read_text())["cases"]

FIELDS = ["eventId", "eventName", "tenantId", "storeId", "campaignId", "productId", "userId", "userType", "clientType", "timestamp", "receivedAt"]
SCHEMA = Schema(
    *[NestedField(n + 1, f"payload_{name}", StringType()) for n, name in enumerate(FIELDS)],
    NestedField(20, "_kafka_metadata_timestamp", TimestamptzType()),
    NestedField(21, "_kafka_metadata_offset", LongType()),
)
ARROW = pa.schema([*[pa.field(f"payload_{name}", pa.string()) for name in FIELDS],
                   pa.field("_kafka_metadata_timestamp", pa.timestamp("us", tz="UTC")), pa.field("_kafka_metadata_offset", pa.int64())])


def event(name: str, at: dt.datetime, *, campaign=None, product=None, user=None, tenant=TENANT, store=STORE, user_type="visitor", client="web",
          event_id=None) -> dict:
    """An interaction as the lake holds it, arriving a minute after it happened."""
    return {
        "payload_eventId": event_id or str(uuid.uuid4()), "payload_eventName": name, "payload_tenantId": tenant, "payload_storeId": store,
        "payload_campaignId": campaign, "payload_productId": product, "payload_userId": user or str(uuid.uuid4()),
        "payload_userType": user_type, "payload_clientType": client,
        "payload_timestamp": at.isoformat().replace("+00:00", "Z"), "payload_receivedAt": at.isoformat().replace("+00:00", "Z"),
        "_kafka_metadata_timestamp": at + dt.timedelta(minutes=1), "_kafka_metadata_offset": 0,
    }


def attribution_cases() -> tuple[list[dict], dict[tuple[str, str], int], dict[tuple[str, str], int]]:
    """The cases' events (each basket at noon on DAY); per (tenant, campaign), its credited baskets and its clicks on DAY."""
    events, credited, clicks = [], {}, {}
    for case in CASES:
        ids = {"U": str(uuid.uuid4()), "V": str(uuid.uuid4()), "P": str(uuid.uuid4()), "Q": str(uuid.uuid4()),
               "A": str(uuid.uuid4()), "B": str(uuid.uuid4()), "T": TENANT, "O": OTHER}
        event_ids, campaigns = {}, {}
        for e in case["events"]:
            product = e.get("product", "P")
            at = NOON + dt.timedelta(hours=e["at"])
            campaigns[e["id"]] = ids[e["campaign"]] if e.get("campaign") else None
            row = event(e["event"], at, campaign=campaigns[e["id"]], product=ids[product] if product else None,
                        user=ids[e.get("user", "U")], tenant=ids[e.get("tenant", "T")], user_type=e.get("userType", "visitor"))
            event_ids[e["id"]] = row["payload_eventId"]
            events.append(row)
            if e["event"] == "click" and campaigns[e["id"]] and at.date() == DAY:
                key = (row["payload_tenantId"], campaigns[e["id"]])
                clicks[key] = clicks.get(key, 0) + 1
        # A basket counts under its own tenant (a click of another tenant is never a candidate).
        for basket, click in case["credits"].items():
            if click:
                key = (ids[next(e for e in case["events"] if e["id"] == basket).get("tenant", "T")], campaigns[click])
                credited[key] = credited.get(key, 0) + 1
    return events, credited, clicks


@pytest.fixture(scope="module")
def lake():
    catalog = load_catalog("lake")
    catalog.create_namespace_if_not_exists("lake_test")
    if catalog.table_exists("lake_test.interactions"):
        catalog.purge_table("lake_test.interactions")
    spec = PartitionSpec(PartitionField(source_id=3, field_id=1000, transform=IdentityTransform(), name="payload_tenantId"),
                         PartitionField(source_id=20, field_id=1001, transform=HourTransform(), name="_kafka_metadata_timestamp_hour"))
    table = catalog.create_table("lake_test.interactions", SCHEMA, partition_spec=spec)
    yield lambda rows: table.append(pa.Table.from_pylist(rows, schema=ARROW))
    catalog.purge_table("lake_test.interactions")


@pytest.fixture(scope="module")
def ch():
    """A throwaway analytics database (and the backfill's scratch one), with the real schema."""
    client = clickhouse_connect.get_client(dsn="http://basketline:basketline_dev@localhost:8123", send_receive_timeout=600)
    database = f"analytics_bf_{uuid.uuid4().hex[:12]}"
    for file in ("01_tables.sql", "02_materialized_views.sql"):
        for statement in job.statements(file, database):
            client.command(statement)
    client.database_name = database
    yield client, database, f"{database}_scratch"
    client.command(f"DROP DATABASE IF EXISTS {database} SYNC")
    client.command(f"DROP DATABASE IF EXISTS {database}_scratch SYNC")
    client.close()


def daily(client, database: str, day: dt.date, tenant: str = TENANT) -> dict[tuple[str, str], tuple[int, int, int]]:
    """(store, campaign) -> (impressions, clicks, click_to_basket) of the tenant's day."""
    rows = client.query(
        f"SELECT toString(store_id), toString(campaign_id), sum(total_impressions), sum(total_clicks), sum(total_click_to_basket)"
        f" FROM {database}.daily_campaign_aggregation WHERE day = {{day:Date}} AND tenant_id = {{tenant:UUID}} GROUP BY ALL",
        parameters={"day": day, "tenant": tenant}).result_rows
    return {(store, campaign): (i, c, b) for store, campaign, i, c, b in rows if (i, c, b) != (0, 0, 0)}


def stale(client, database: str, day: dt.date, campaign: str, impressions: int, tenant: str = TENANT) -> None:
    """A daily row as live counting might have left it."""
    client.insert(f"{database}.daily_campaign_aggregation", [[day, tenant, STORE, campaign] + [impressions] + [0] * 8],
                  column_names=["day", "tenant_id", "store_id", "campaign_id", "total_impressions", "total_web_impressions", "total_mobile_impressions",
                                "total_clicks", "total_web_clicks", "total_mobile_clicks", "total_click_to_basket", "total_web_click_to_basket", "total_mobile_click_to_basket"])


def test_recomputes_the_days_from_the_lake_as_live_counting_would(lake, ch):
    client, database, scratch = ch
    events, credited, clicks = attribution_cases()
    ad, erased, alice, bob = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    seen_twice = event("impression", NOON, campaign=ad, user=alice)
    gone_tenant = str(uuid.uuid4())
    events += [
        seen_twice, dict(seen_twice),  # delivered twice: counted once
        event("impression", NOON + dt.timedelta(hours=1), campaign=ad, user=bob),
        event("impression", NOON, campaign=ad, store=None),  # sent without a store
        event("impression", NOON, campaign=ad, user=erased),  # erased shopper
        event("impression", NOON, campaign=ad, tenant=gone_tenant),  # deleted tenant
        event("home_view", NOON),  # not an ad event
    ]
    lake(events)
    client.insert(f"{database}.deleted_users", [[TENANT, erased, NOON]], column_names=["tenant_id", "user_id", "deleted_at"])
    client.insert(f"{database}.deleted_tenants", [[gone_tenant, "Gone", NOON]], column_names=["tenant_id", "name", "deleted_at"])
    stale(client, database, DAY, ad, 999)  # replaced
    kept_day = DAY - dt.timedelta(days=1)
    stale(client, database, kept_day, ad, 5)  # outside the days: kept

    rows = job.backfill(client, SOURCE, DAY, DAY, [], database=database, scratch=scratch, today=TODAY)

    assert rows["daily_campaign_aggregation"] > 0 and rows["daily_campaign_customers_aggregation"] > 0
    counts = daily(client, database, DAY)
    assert counts[(STORE, ad)] == (2, 0, 0)
    assert counts[(job.NO_STORE, ad)] == (1, 0, 0)
    for tenant, campaign in set(credited) | set(clicks):
        found = daily(client, database, DAY, tenant).get((STORE, campaign), (0, 0, 0))[1:]
        assert found == (clicks.get((tenant, campaign), 0), credited.get((tenant, campaign), 0)), (tenant, campaign)
    assert daily(client, database, kept_day) == {(STORE, ad): (5, 0, 0)}
    assert daily(client, database, DAY, gone_tenant) == {}
    customers = client.query(f"SELECT uniqCombined64Merge(has_visited) FROM {database}.daily_campaign_customers_aggregation"
                             " WHERE day = {day:Date} AND campaign_id = {ad:UUID} AND store_id = {store:UUID}",
                             parameters={"day": DAY, "ad": ad, "store": STORE}).result_rows[0][0]
    assert customers == 2
    assert client.query(f"SELECT from_day, to_day, tenants, rolled_back FROM {database}.backfill_runs").result_rows == [(DAY, DAY, [], False)]


def test_limits_to_tenants_and_rolls_back(lake, ch):
    client, database, scratch = ch
    before = daily(client, database, DAY)
    other_before = daily(client, database, DAY, OTHER)
    ad = next(campaign for _, campaign in before)
    stale(client, database, DAY, ad, 100)
    stale(client, database, DAY, ad, 7, tenant=OTHER)

    job.backfill(client, SOURCE, DAY, DAY, [TENANT], database=database, scratch=scratch, today=TODAY)
    # The tenant's day recomputed again; the other tenant's left as it was.
    assert daily(client, database, DAY) == before
    other = daily(client, database, DAY, OTHER)
    assert other[(STORE, ad)] == (other_before.get((STORE, ad), (0, 0, 0))[0] + 7, 0, 0)

    job.rollback(client, database=database, scratch=scratch)
    with_stale = dict(before)
    with_stale[(STORE, ad)] = (before[(STORE, ad)][0] + 100, *before[(STORE, ad)][1:])
    assert daily(client, database, DAY) == with_stale
    assert client.query(f"SELECT countIf(rolled_back) FROM {database}.backfill_runs").result_rows[0][0] == 1
    # The scratch database stays until the next run; only the latest run can be rolled back, once.
    assert any(name.startswith("previous_") for name in job.tables_in(client, scratch))
    with pytest.raises(ValueError, match="rolled back already"):
        job.rollback(client, database=database, scratch=scratch)


def test_recomputes_sessions_that_began_on_the_day(lake, ch):
    client, database, scratch = ch
    promo, product, carol, dave, erin = (str(uuid.uuid4()) for _ in range(5))
    at = lambda hour, minute=0: dt.datetime.combine(DAY, dt.time(hour, minute), dt.UTC)  # noqa: E731
    lake([
        # Carol: one session that clicked the promo and added its product to the cart...
        event("impression", at(9), campaign=promo, product=product, user=carol),
        event("click", at(9, 10), campaign=promo, product=product, user=carol),
        event("add_to_cart", at(9, 20), product=product, user=carol),
        # ...and, 70 minutes later, another that only saw it.
        event("impression", at(10, 30), campaign=promo, product=product, user=carol),
        # Dave's session began the day before (20 minutes apart): not one of the day's.
        event("impression", at(0) - dt.timedelta(minutes=10), campaign=promo, user=dave),
        event("click", at(0, 10), campaign=promo, product=product, user=dave),
        # Erin, on the mobile app.
        event("impression", at(15), campaign=promo, user=erin, client="mobile"),
    ])

    rows = job.backfill(client, SOURCE, DAY, DAY, [], ["daily_campaign_sessions_aggregation"], database=database, scratch=scratch, today=TODAY)

    assert rows["daily_campaign_sessions_aggregation"] > 0
    sessions = client.query(
        f"SELECT uniqCombined64Merge(total_sessions), uniqCombined64Merge(total_web_sessions), uniqCombined64Merge(total_mobile_sessions),"
        f" uniqCombined64Merge(total_converted_sessions) FROM {database}.daily_campaign_sessions_aggregation"
        " WHERE tenant_id = {tenant:UUID} AND store_id = {store:UUID} AND campaign_id = {promo:UUID} AND day = {day:Date}",
        parameters={"tenant": TENANT, "store": STORE, "promo": promo, "day": DAY}).result_rows[0]
    assert sessions == (3, 2, 1, 1)


def test_refuses_days_the_lake_lacks_or_live_events_can_change(lake, ch):
    client, database, scratch = ch
    with pytest.raises(ValueError, match="can still get events"):
        job.check_range(client, SOURCE, DAY, TODAY - dt.timedelta(days=2), TODAY)
    # The lake began with the cases' earliest click, 8 days before DAY.
    with pytest.raises(ValueError, match="isn't in the lake whole"):
        job.check_range(client, SOURCE, DAY - dt.timedelta(days=8), DAY, TODAY)
    # The fixture lake ends a few days after DAY: a scheduled run waits for it to catch up.
    with pytest.raises(ValueError, match="the lake is behind"):
        job.check_lake_caught_up(client, SOURCE, DAY)
    with pytest.raises(ValueError, match="no such daily table"):
        job.backfill(client, SOURCE, DAY, DAY, [], ["daily_nothing"], database=database, scratch=scratch, today=TODAY)
