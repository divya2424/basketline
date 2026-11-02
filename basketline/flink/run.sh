#!/usr/bin/env bash
# Starts a one-container Flink cluster (job manager + task manager), submits the
# job in sql/, and exits when the job stops running so Docker or Kubernetes
# restarts the container. A restart resumes from the newest checkpoint: Kafka offsets and
# the attribution join's state (clicks and baskets waiting for each other).
set -euo pipefail

: "${KAFKA_BOOTSTRAP_SERVERS:=localhost:9092}"
: "${KAFKA_TOPIC_PREFIX:=}"
: "${KAFKA_GROUP_ID:=events-to-clickhouse}"
# Used only when there is no checkpoint yet (earliest-offset, latest-offset, group-offsets).
: "${KAFKA_STARTUP_MODE:=earliest-offset}"
: "${CHECKPOINT_DIR:=/checkpoints}"
export FLINK_LOG_DIR=${FLINK_LOG_DIR:-/tmp/flink-log}
REST=http://localhost:8081
mkdir -p "$FLINK_LOG_DIR"

/opt/flink/bin/jobmanager.sh start
/opt/flink/bin/taskmanager.sh start
trap '/opt/flink/bin/taskmanager.sh stop; /opt/flink/bin/jobmanager.sh stop' EXIT
until curl -fs "$REST/overview" | grep -q '"taskmanagers":1'; do sleep 1; done

job=/tmp/job.sql
# A checkpoint is complete once its _metadata file is written.
latest=$(ls -t "$CHECKPOINT_DIR"/*/chk-*/_metadata 2>/dev/null | head -n 1 || true)
if [ -n "$latest" ]; then
  echo "Restoring from $(dirname "$latest")"
  # CLAIM: the new job owns the checkpoint and deletes it once it is superseded.
  printf "SET 'execution.state-recovery.path' = '%s';\nSET 'execution.state-recovery.claim-mode' = 'CLAIM';\n" "$(dirname "$latest")" > "$job"
else
  : > "$job"
fi
# One job from sql/ (README "Layout"): settings, tables, views, then every
# pipeline's INSERT in one statement set, so the source is read once and one
# checkpoint covers all of them. Files run in name order.
sql=/opt/job/sql
{
  cat "$sql"/settings.sql "$sql"/connectors/*.sql "$sql"/views/*.sql
  printf 'EXECUTE STATEMENT SET\nBEGIN\n'
  cat "$sql"/pipelines/*.sql
  printf 'END;\n'
} | sed -e "s|__KAFKA_BOOTSTRAP_SERVERS__|$KAFKA_BOOTSTRAP_SERVERS|g" \
    -e "s|__TOPIC_PREFIX__|$KAFKA_TOPIC_PREFIX|g" \
    -e "s|__KAFKA_GROUP_ID__|$KAFKA_GROUP_ID|g" \
    -e "s|__KAFKA_STARTUP_MODE__|$KAFKA_STARTUP_MODE|g" \
    -e "s|__CHECKPOINT_DIR__|$CHECKPOINT_DIR|g" >> "$job"
/opt/flink/bin/sql-client.sh -f "$job"

# Flink restarts failed tasks itself (from the last checkpoint); this loop only
# notices when the job is gone for good.
while curl -fs "$REST/jobs/overview" | grep -Eq '"state":"(CREATED|INITIALIZING|RUNNING|RESTARTING)"'; do
  sleep 10
done
echo "The job is no longer running" >&2
tail -n 100 "$FLINK_LOG_DIR"/*standalonesession*.log >&2 || true
exit 1
