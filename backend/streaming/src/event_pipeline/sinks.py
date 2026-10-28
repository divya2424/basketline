import logging
import uuid
from datetime import datetime, timezone

import clickhouse_connect

from event_pipeline.config import settings
from event_pipeline.schemas import EVENT_COLUMNS
from event_pipeline.transformations import prepare_batch

logger = logging.getLogger(__name__)


def _uuid(value):
    return uuid.UUID(value) if value else None


def _datetime(epoch_ms):
    # Naive UTC, as the DateTime64(3, 'UTC') columns expect.
    if epoch_ms is None:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).replace(tzinfo=None)


def to_clickhouse_row(row) -> list:
    """One parsed Spark row → values in EVENT_COLUMNS order."""
    return [
        uuid.UUID(row["event_id"]),
        row["event_name"],
        _uuid(row["campaign_id"]),
        _uuid(row["product_id"]),
        _uuid(row["user_id"]),
        uuid.UUID(row["tenant_id"]),
        row["page_name"],
        row["feature_name"],
        _uuid(row["attribution_id"]),
        row["properties"],
        _datetime(row["event_time_ms"]),
        _datetime(row["received_at_ms"]),
    ]


def unique_events(rows):
    """Yield each event once per partition (see prepare_batch for why that's enough).

    Repeats across batches are merged by ReplacingMergeTree and counted once by
    uniqExact(event_id).
    """
    seen = set()
    for row in rows:
        if row["event_id"] not in seen:
            seen.add(row["event_id"])
            yield row


def write_batch(batch_df, batch_id: int) -> None:
    """Write a micro-batch of events to ClickHouse, one insert stream per partition.

    If the job restarts mid-batch, Spark replays the batch from the checkpoint.
    The replay produces the same inserts, which ClickHouse skips as duplicates
    (non_replicated_deduplication_window).
    """
    prepare_batch(batch_df, settings.spark_shuffle_partitions).foreachPartition(_write_partition)
    logger.info("Processed batch_id=%s", batch_id)


def _write_partition(rows) -> None:
    client = None
    payload = []
    try:
        for row in unique_events(rows):
            payload.append(to_clickhouse_row(row))
            # Bound memory use per Spark partition.
            if len(payload) >= settings.clickhouse_insert_batch_size:
                client = client or _client()
                _insert(client, payload)
                payload.clear()
        if payload:
            client = client or _client()
            _insert(client, payload)
    finally:
        if client is not None:
            client.close()


def _client():
    # Opened only for partitions that have rows (empty batches cost nothing).
    return clickhouse_connect.get_client(
        host=settings.clickhouse_host,
        port=settings.clickhouse_port,
        username=settings.clickhouse_username,
        password=settings.clickhouse_password,
        database=settings.clickhouse_database,
        secure=settings.clickhouse_secure,
    )


def _insert(client, payload: list[list]) -> None:
    client.insert(settings.clickhouse_table, payload, column_names=EVENT_COLUMNS)
