-- Job-wide settings. __CHECKPOINT_DIR__ and the other __PLACEHOLDERS__ in these files are filled in by run.sh.
SET 'pipeline.name' = 'events-to-clickhouse';
SET 'table.local-time-zone' = 'UTC';
-- Every 60 s: rows are written as they are processed, not at checkpoints, so this
-- doesn't delay them. After a restart up to 60 s of events are read again; the
-- nightly check in ClickHouse removes those copies from the daily totals.
SET 'execution.checkpointing.interval' = '60 s';
SET 'execution.checkpointing.externalized-checkpoint-retention' = 'RETAIN_ON_CANCELLATION';
SET 'state.backend.type' = 'rocksdb';
SET 'execution.checkpointing.incremental' = 'true';
SET 'execution.checkpointing.dir' = 'file://__CHECKPOINT_DIR__';
-- Each checkpoint is also kept on the task manager's own disk, and a task that
-- fails is restored from there, not from checkpoint storage: with terabytes of
-- join state on S3, that is minutes instead of tens of minutes. A lost task
-- manager still restores from checkpoint storage.
SET 'execution.checkpointing.local-backup.enabled' = 'true';
SET 'execution.state-recovery.from-local' = 'true';
-- A topic partition without new events stops holding back the watermark after a
-- minute, so quiet topics don't stall the session windows.
SET 'table.exec.source.idle-timeout' = '1 min';
