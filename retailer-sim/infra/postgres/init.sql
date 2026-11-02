-- The simulated retailer's own Postgres: one database and one login per service.
-- PUBLIC can't connect, so a service's credentials only open its own database.
CREATE ROLE product_svc LOGIN PASSWORD 'product_svc_dev';
CREATE ROLE campaign_svc LOGIN PASSWORD 'campaign_svc_dev';
CREATE ROLE retailer_auth_svc LOGIN PASSWORD 'retailer_auth_svc_dev';

CREATE DATABASE product_db OWNER product_svc;
CREATE DATABASE campaign_db OWNER campaign_svc;
CREATE DATABASE retailer_auth_db OWNER retailer_auth_svc;

REVOKE CONNECT ON DATABASE product_db, campaign_db, retailer_auth_db FROM PUBLIC;
GRANT CONNECT ON DATABASE product_db TO product_svc;
GRANT CONNECT ON DATABASE campaign_db TO campaign_svc;
GRANT CONNECT ON DATABASE retailer_auth_db TO retailer_auth_svc;
