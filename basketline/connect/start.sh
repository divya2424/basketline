#!/bin/sh
# The broker creates no topics by itself: the lake sink's control topic (its
# workers' commit messages, connect/lake-sink.json) is created here, then the worker starts.
set -e
CONFIG=/opt/connect/connect-distributed.properties
BOOTSTRAP=$(sed -n 's/^bootstrap.servers=//p' "$CONFIG")
/opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
  --topic lake-sink.control --partitions 1 --replication-factor "${CONTROL_TOPIC_REPLICATION:-1}"
exec /opt/kafka/bin/connect-distributed.sh "$CONFIG"
