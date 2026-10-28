import uuid
from datetime import datetime

from event_pipeline.schemas import EVENT_COLUMNS
from event_pipeline.sinks import to_clickhouse_row


def test_to_clickhouse_row_converts_ids_and_times():
    event_id = str(uuid.uuid4())
    campaign = str(uuid.uuid4())
    tenant = str(uuid.uuid4())
    values = to_clickhouse_row(
        {
            "event_id": event_id,
            "event_name": "add_to_cart",
            "campaign_id": campaign,
            "product_id": None,
            "user_id": None,
            "tenant_id": tenant,
            "page_name": "home",
            "feature_name": "product_card",
            "attribution_id": None,
            "properties": '{"quantity":1}',
            "event_time_ms": 1_793_181_601_250,
            "received_at_ms": 1_793_181_602_000,
        }
    )
    row = dict(zip(EVENT_COLUMNS, values))
    assert row["event_id"] == uuid.UUID(event_id)
    assert row["campaign_id"] == uuid.UUID(campaign)
    assert row["product_id"] is None
    assert row["tenant_id"] == uuid.UUID(tenant)
    assert row["event_time"] == datetime(2026, 10, 28, 10, 0, 1, 250_000)
    assert row["received_at"] == datetime(2026, 10, 28, 10, 0, 2)
