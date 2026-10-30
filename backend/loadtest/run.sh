#!/usr/bin/env bash
# Runs analytics.js once per rate in RATES (ingestion requests/s; 9 events each),
# then measures that run's freshness in ClickHouse. Run from backend/, with the
# gateway's rate limits raised (see README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

RATES=${RATES:-"100 250 500 1000"}
DURATION=${DURATION:-60s}
READ_RATE=${READ_RATE:-20}
SETTLE_SECONDS=${SETTLE_SECONDS:-75} # lets a Kafka backlog drain through Flink into ClickHouse

for rate in $RATES; do
  run_id="lt-$(date +%s)-$rate"
  echo "== $rate req/s ($((rate * 10)) events/s) for $DURATION, run $run_id" >&2
  docker run --rm -i --network ecommerce-analytics_default \
    -e RATE="$rate" -e READ_RATE="$READ_RATE" -e DURATION="$DURATION" -e RUN_ID="$run_id" \
    grafana/k6:1.3.0 run -q - < loadtest/analytics.js | tail -1 || true # k6 exits non-zero when a target is missed
  sleep "$SETTLE_SECONDS"
  docker compose exec -T clickhouse clickhouse-client --user ecommerce_analytics --password ecommerce_analytics_dev \
    --param_run="$run_id" --query "$(cat loadtest/freshness.sql)" < /dev/null
done
