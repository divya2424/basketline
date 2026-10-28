import json
import uuid
from datetime import datetime

from event_pipeline.sinks import unique_events
from event_pipeline.transformations import parse_events, prepare_batch

CAMPAIGN = "11111111-aaaa-4aaa-8aaa-111111111111"
PRODUCT = "22222222-bbbb-4bbb-8bbb-222222222222"
TENANT = "33333333-cccc-4ccc-8ccc-333333333333"


def envelope(**payload) -> str:
    base = {
        "eventId": str(uuid.uuid4()),
        "eventName": "click",
        "campaignId": CAMPAIGN,
        "productId": PRODUCT,
        "userId": None,
        "tenantId": TENANT,
        "pageName": "home",
        "featureName": "product_card",
        "attributionId": None,
        "properties": {"position": 1},
        "timestamp": "2026-10-28T10:00:01.250Z",
        "receivedAt": "2026-10-28T10:00:02.000Z",
    }
    base.update(payload)
    return json.dumps(
        {"eventId": base["eventId"], "eventType": "AnalyticsEventRecorded", "payload": base}
    )


def kafka_rows(spark, *values):
    rows = [
        (value, "analytics.click.v1", 0, offset, datetime(2026, 10, 28))
        for offset, value in enumerate(values)
    ]
    return spark.createDataFrame(rows, ["value", "topic", "partition", "offset", "timestamp"])


def test_parse_events_maps_the_payload_to_clickhouse_columns(spark):
    value = envelope()
    [row] = parse_events(kafka_rows(spark, value)).collect()
    payload = json.loads(value)["payload"]
    assert row["event_id"] == payload["eventId"]
    assert row["event_name"] == "click"
    assert row["campaign_id"] == CAMPAIGN
    assert row["product_id"] == PRODUCT
    assert row["user_id"] is None
    assert row["tenant_id"] == TENANT
    assert json.loads(row["properties"]) == {"position": 1}
    # 2026-10-28T10:00:01.250Z, independent of the local time zone.
    assert row["event_time_ms"] == 1_793_181_601_250
    assert row["received_at_ms"] == 1_793_181_602_000


def test_parse_events_falls_back_to_the_event_time_without_received_at(spark):
    [row] = parse_events(kafka_rows(spark, envelope(receivedAt=None))).collect()
    assert row["received_at_ms"] == row["event_time_ms"]


def test_parse_events_drops_records_that_cannot_be_stored(spark):
    good = envelope()
    df = kafka_rows(
        spark,
        good,
        "not json",
        envelope(eventId=None),
        envelope(eventId="evt-1"),
        envelope(eventName=""),
        envelope(tenantId=None),
        envelope(tenantId="tenant_ecommerce"),
        envelope(timestamp=None),
    )
    rows = parse_events(df).collect()
    assert [row["event_id"] for row in rows] == [json.loads(good)["eventId"]]


def test_parse_events_nulls_malformed_optional_ids_and_defaults_properties(spark):
    [row] = parse_events(
        kafka_rows(spark, envelope(campaignId="campaign_001", productId=None, properties=None))
    ).collect()
    assert row["campaign_id"] is None
    assert row["product_id"] is None
    assert row["properties"] == "{}"


def test_prepare_batch_groups_each_tenant_and_event_in_one_sorted_partition(spark):
    values = [
        envelope(tenantId=tenant, eventName=name, timestamp=f"2026-10-28T10:00:0{second}Z")
        for tenant in [str(uuid.uuid4()) for _ in range(3)]
        for name in ["impression", "click", "add_to_cart"]
        for second in [3, 1, 2]
    ]
    batch = prepare_batch(parse_events(kafka_rows(spark, *values)), partitions=4)
    partitions = batch.rdd.glom().collect()

    assert len(partitions) == 4
    assert sum(len(rows) for rows in partitions) == len(values)
    # Every (tenant, event) slice lives in exactly one partition…
    slices = {}
    for index, rows in enumerate(partitions):
        for row in rows:
            slices.setdefault((row["tenant_id"], row["event_name"]), set()).add(index)
    assert all(len(found) == 1 for found in slices.values())
    # …and each partition is in the ClickHouse sort order.
    for rows in partitions:
        keys = [(r["tenant_id"], r["event_name"], r["event_time_ms"], r["event_id"]) for r in rows]
        assert keys == sorted(keys)


def test_copies_of_an_event_meet_in_one_partition_and_are_written_once(spark):
    repeated = envelope()
    values = [repeated, repeated, envelope(), repeated]
    batch = prepare_batch(parse_events(kafka_rows(spark, *values)), partitions=4)
    written = [
        row["event_id"] for rows in batch.rdd.glom().collect() for row in unique_events(rows)
    ]
    assert len(written) == 2
    assert written.count(json.loads(repeated)["eventId"]) == 1
