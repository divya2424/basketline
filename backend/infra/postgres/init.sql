-- One database and one login per service. PUBLIC can't connect, so a service's
-- credentials only open its own database: cross-service SQL is impossible.
-- analytics-service has no Postgres database: its events live in ClickHouse.
CREATE ROLE identity_svc LOGIN PASSWORD 'identity_svc_dev';
CREATE ROLE product_svc LOGIN PASSWORD 'product_svc_dev';
CREATE ROLE campaign_svc LOGIN PASSWORD 'campaign_svc_dev';
CREATE ROLE gateway_svc LOGIN PASSWORD 'gateway_svc_dev';

CREATE DATABASE identity_db OWNER identity_svc;
CREATE DATABASE product_db OWNER product_svc;
CREATE DATABASE campaign_db OWNER campaign_svc;
CREATE DATABASE gateway_db OWNER gateway_svc;

REVOKE CONNECT ON DATABASE identity_db, product_db, campaign_db, gateway_db FROM PUBLIC;
GRANT CONNECT ON DATABASE identity_db TO identity_svc;
GRANT CONNECT ON DATABASE product_db TO product_svc;
GRANT CONNECT ON DATABASE campaign_db TO campaign_svc;
GRANT CONNECT ON DATABASE gateway_db TO gateway_svc;
