"""The export job against the running stack's ClickHouse, Postgres catalog and S3:

    docker compose up -d clickhouse postgres archive-storage
    npm run test:airflow

It writes to the archive_test namespace, so the real archive tables are untouched,
and reads back only its own tenant's rows.
"""

import datetime as dt
import os
import sys
import uuid
from pathlib import Path

# Before importing PyIceberg, which reads its configuration from the environment then.
for name, value in {
    "CLICKHOUSE_URL": "http://basketline:basketline_dev@localhost:8123/analytics",
    "PYICEBERG_CATALOG__ARCHIVE__TYPE": "sql",
    "PYICEBERG_CATALOG__ARCHIVE__URI": "postgresql+psycopg2://iceberg_svc:iceberg_svc_dev@localhost:5432/iceberg_catalog_db",
    "PYICEBERG_CATALOG__ARCHIVE__WAREHOUSE": "s3://ad-insights-archive",
    "PYICEBERG_CATALOG__ARCHIVE__S3__ENDPOINT": "http://localhost:8333",
    "PYICEBERG_CATALOG__ARCHIVE__S3__REGION": "us-east-1",
    "PYICEBERG_CATALOG__ARCHIVE__S3__ACCESS_KEY_ID": "archive",
    "PYICEBERG_CATALOG__ARCHIVE__S3__SECRET_ACCESS_KEY": "archive_dev",
}.items():
    os.environ.setdefault(name, value)
os.environ["ARCHIVE_NAMESPACE"] = "archive_test"

import clickhouse_connect  # noqa: E402
import pytest  # noqa: E402
from pyiceberg.catalog import load_catalog  # noqa: E402
from pyiceberg.expressions import EqualTo  # noqa: E402

sys.path.insert(0, str(Path(__file__).parents[1] / "jobs"))
from export_archive import export  # noqa: E402

TODAY = dt.datetime.now(dt.UTC).date()
DAY = TODAY - dt.timedelta(days=7)
TENANT = uuid.uuid4()
COLUMNS = ["event_id", "event_name", "campaign_id", "product_id", "user_id", "tenant_id", "page_name", "feature_name",
           "properties", "event_time", "received_at", "ingested_at", "user_type"]


def archived(table: str):
    rows = load_catalog("archive").load_table(f"archive_test.{table}").scan(row_filter=EqualTo("tenant_id", str(TENANT))).to_arrow()
    return sorted(rows.to_pylist(), key=lambda row: row.get("event_time") or row["session_start"])


@pytest.fixture(scope="module")
def clickhouse():
    client = clickhouse_connect.get_client(dsn=os.environ["CLICKHOUSE_URL"])
    yield client
    client.close()


def test_exports_a_day_once_however_often_it_runs(clickhouse):
    noon = dt.datetime.combine(DAY, dt.time(12), dt.UTC)
    campaign, click, visitor = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    impression = [uuid.uuid4(), "impression", campaign, None, visitor, TENANT, None, None, "{}", noon, noon, noon, "visitor"]
    clicked = [click, "click", campaign, None, None, TENANT, None, None, '{"a":1}', noon + dt.timedelta(minutes=1), noon, noon, "registered"]
    next_day = [uuid.uuid4(), "impression", campaign, None, None, TENANT, None, None, "{}", noon + dt.timedelta(hours=12), noon, noon, "visitor"]
    clickhouse.insert("events", [impression, clicked, next_day], column_names=COLUMNS)
    # The impression redelivered later: a second row until ClickHouse merges it away.
    clickhouse.insert("events", [impression[:11] + [noon + dt.timedelta(minutes=5), "visitor"]], column_names=COLUMNS)
    basket = [uuid.uuid4(), click, TENANT, campaign, None, None, noon + dt.timedelta(minutes=2), noon + dt.timedelta(minutes=1)]
    clickhouse.insert("attributed_baskets", [basket], column_names=["basket_event_id", "click_event_id", "tenant_id", "campaign_id",
                                                                    "product_id", "user_id", "event_time", "click_time"])

    session = [uuid.uuid4(), TENANT, visitor, "visitor", noon, noon + dt.timedelta(minutes=2), 3, 1, 1, 1, True, False, [campaign], [f"{campaign}:{click}"], []]
    clickhouse.insert("sessions", [session], column_names=["session_id", "tenant_id", "user_id", "user_type", "session_start", "last_event_time", "events",
                                                           "impressions", "clicks", "add_to_carts", "web", "mobile", "campaigns", "clicked", "added"])

    for _ in range(2):
        export("events", DAY)
        export("attributed_baskets", DAY)
        export("sessions", DAY)

    events = archived("events")
    assert [(row["event_id"], row["event_name"]) for row in events] == [(str(impression[0]), "impression"), (str(click), "click")]
    assert events[1]["campaign_id"] == str(campaign) and events[1]["product_id"] is None and events[1]["properties"] == '{"a":1}'
    assert events[1]["event_time"] == noon + dt.timedelta(minutes=1)
    # A column added after the table was created (user_type) is added to it; dropped ones (anonymous_id, attribution_id) are NULL.
    assert [(row["user_id"], row["user_type"], row["anonymous_id"], row["attribution_id"]) for row in events] == [
        (str(visitor), "visitor", None, None),
        (None, "registered", None, None),
    ]
    assert [(row["basket_event_id"], row["click_event_id"]) for row in archived("attributed_baskets")] == [(str(basket[0]), str(click))]
    sessions = archived("sessions")
    assert [(row["session_id"], row["events"], row["web"], row["campaigns"], row["clicked"], row["added"]) for row in sessions] == [
        (str(session[0]), 3, True, [str(campaign)], [f"{campaign}:{click}"], []),
    ]


def test_refuses_a_day_clickhouse_no_longer_keeps():
    with pytest.raises(SystemExit, match="retention"):
        export("events", TODAY - dt.timedelta(days=20))
