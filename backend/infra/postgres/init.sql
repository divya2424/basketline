-- One database and one login per service. PUBLIC can't connect, so a service's
-- credentials only open its own database: cross-service SQL is impossible.
-- analytics-service has no Postgres database: its events live in ClickHouse.
CREATE ROLE identity_svc LOGIN PASSWORD 'identity_svc_dev';
CREATE ROLE product_svc LOGIN PASSWORD 'product_svc_dev';
CREATE ROLE campaign_svc LOGIN PASSWORD 'campaign_svc_dev';
CREATE ROLE gateway_svc LOGIN PASSWORD 'gateway_svc_dev';
-- Airflow's metadata, and the Iceberg catalog of the archive (locally; Glue on AWS).
CREATE ROLE airflow_svc LOGIN PASSWORD 'airflow_svc_dev';
CREATE ROLE iceberg_svc LOGIN PASSWORD 'iceberg_svc_dev';

CREATE DATABASE identity_db OWNER identity_svc;
CREATE DATABASE product_db OWNER product_svc;
CREATE DATABASE campaign_db OWNER campaign_svc;
CREATE DATABASE gateway_db OWNER gateway_svc;
CREATE DATABASE airflow_db OWNER airflow_svc;
CREATE DATABASE iceberg_catalog_db OWNER iceberg_svc;

REVOKE CONNECT ON DATABASE identity_db, product_db, campaign_db, gateway_db, airflow_db, iceberg_catalog_db FROM PUBLIC;
GRANT CONNECT ON DATABASE identity_db TO identity_svc;
GRANT CONNECT ON DATABASE product_db TO product_svc;
GRANT CONNECT ON DATABASE campaign_db TO campaign_svc;
GRANT CONNECT ON DATABASE gateway_db TO gateway_svc;
GRANT CONNECT ON DATABASE airflow_db TO airflow_svc;
GRANT CONNECT ON DATABASE iceberg_catalog_db TO iceberg_svc;
