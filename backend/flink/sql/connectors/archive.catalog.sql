-- The Iceberg archive (the same catalog and tables as airflow/jobs/export_archive.py,
-- which creates them): raw events and credited basket additions are appended as
-- they arrive, committed at each checkpoint. run.sh fills in the catalog's
-- options: a JDBC catalog on Postgres with S3 locally (ARCHIVE_JDBC_URI set),
-- Glue with the pod's IAM role on AWS.
CREATE CATALOG archive WITH (
  'type' = 'iceberg',
  'io-impl' = 'org.apache.iceberg.aws.s3.S3FileIO',
  'warehouse' = '__ARCHIVE_WAREHOUSE__',
  'cache-enabled' = 'false',
  __ARCHIVE_CATALOG_OPTIONS__
);
