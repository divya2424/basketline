"""Recomputes historical days from the raw Iceberg archive with the current rules,
as small exact rows that load_backfill.py turns into ClickHouse's daily tables.

    spark_backfill.py --run-id R --from 2026-08-01 --to 2026-09-01 [--tenants all|<uuid>,<uuid>] [--allow-partial-context]

Reads archive.<ARCHIVE_NAMESPACE>.events for [from - 7 days, to + 1 day) and
writes, for the days in [from, to) and the tenants in scope, into the namespace
BACKFILL_NAMESPACE (partitioned by run_id, so a run only replaces its own rows):

  event_totals   one row per (day, tenant, campaign): the 9 total_* counts of
                 daily_campaign_aggregation
  customer_days  distinct (day, tenant, campaign, user, metric, client type,
                 user type): ClickHouse builds the customer sketches from these
  sessions       one row per session, with analytics.sessions' columns

The rules are the live pipeline's (backend/flink/sql/pipelines): an add_to_cart
of product P is credited to the same user's latest click on P in the 7 days
before it, and a session ends after 6 hours without events. A rule change must
change both; airflow/tests/fixtures/attribution_cases.json runs the same cases
through Flink (test/flink.kafka.test.ts) and this job (test_history_backfill.py).

Runs locally (PySpark in local mode, a JDBC catalog on Postgres, S3 on
SeaweedFS) or on EMR Serverless (the Glue catalog and an IAM role); see
spark_session().
"""

import argparse
import datetime as dt
import os
import re
from urllib.parse import urlparse

from pyspark.sql import SparkSession

ATTRIBUTION_WINDOW_DAYS = 7
SESSION_GAP_HOURS = 6
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def spark_session() -> SparkSession:
    """The archive catalog as Spark catalog `archive`, from the same environment as PyIceberg's.

    TYPE sql: Iceberg's JDBC catalog on the database PyIceberg's SQL catalog uses
    (they share its iceberg_tables table), with S3FileIO on the S3 endpoint.
    TYPE glue: the Glue catalog, with S3 access through the job's IAM role.
    """
    env = lambda name, default=None: os.environ.get(f"PYICEBERG_CATALOG__ARCHIVE__{name}", default)  # noqa: E731
    catalog = "spark.sql.catalog.archive"
    builder = (
        SparkSession.builder.appName("history-backfill")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(catalog, "org.apache.iceberg.spark.SparkCatalog")
        .config(f"{catalog}.warehouse", env("WAREHOUSE"))
        .config(f"{catalog}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
        # Read each table's current snapshot: other writers (the export, the cleanup) commit to them too.
        .config(f"{catalog}.cache-enabled", "false")
        .config("spark.sql.session.timeZone", "UTC")
    )
    if os.environ.get("SPARK_JARS"):
        builder = builder.config("spark.jars", os.environ["SPARK_JARS"])
    if env("TYPE") == "glue":
        builder = builder.config(f"{catalog}.catalog-impl", "org.apache.iceberg.aws.glue.GlueCatalog")
    else:
        # postgresql+psycopg2://user:password@host:port/db → jdbc:postgresql://host:port/db
        uri = urlparse(env("URI"))
        builder = (
            builder.config(f"{catalog}.catalog-impl", "org.apache.iceberg.jdbc.JdbcCatalog")
            .config(f"{catalog}.uri", f"jdbc:postgresql://{uri.hostname}:{uri.port or 5432}{uri.path}")
            .config(f"{catalog}.jdbc.user", uri.username)
            .config(f"{catalog}.jdbc.password", uri.password)
            .config(f"{catalog}.s3.endpoint", env("S3__ENDPOINT"))
            .config(f"{catalog}.s3.path-style-access", "true")
            .config(f"{catalog}.s3.access-key-id", env("S3__ACCESS_KEY_ID"))
            .config(f"{catalog}.s3.secret-access-key", env("S3__SECRET_ACCESS_KEY"))
            .config(f"{catalog}.client.region", env("S3__REGION", "us-east-1"))
        )
    return builder.getOrCreate()


def parse_tenants(value: str) -> list[str] | None:
    """None for all tenants, else the listed tenant UUIDs."""
    if value == "all":
        return None
    tenants = [t.strip().lower() for t in value.split(",") if t.strip()]
    if not tenants or not all(UUID.match(t) for t in tenants):
        raise SystemExit(f"--tenants must be 'all' or comma-separated tenant UUIDs, not {value!r}")
    return tenants


def write(spark: SparkSession, namespace: str, name: str, query: str, run_id: str) -> int:
    """Replaces this run's rows of backfill table `name` with the query's rows."""
    table = f"archive.{namespace}.{name}"
    rows = spark.sql(query)
    location = f"{os.environ['PYICEBERG_CATALOG__ARCHIVE__WAREHOUSE'].rstrip('/')}/{namespace}/{name}"
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS archive.{namespace}")
    # The same path in every catalog, so ClickHouse finds it (load_backfill.py).
    columns = ", ".join(f"`{f.name}` {f.dataType.simpleString()}" for f in rows.schema.fields)
    spark.sql(f"CREATE TABLE IF NOT EXISTS {table} ({columns}) USING iceberg PARTITIONED BY (run_id) LOCATION '{location}'")
    rows.writeTo(table).overwritePartitions()
    return spark.table(table).where(f"run_id = '{run_id}'").count()


def backfill(spark: SparkSession, run_id: str, start: dt.date, end: dt.date, tenants: list[str] | None, allow_partial_context: bool) -> dict:
    archive = f"archive.{os.environ.get('ARCHIVE_NAMESPACE', 'archive')}.events"
    context_start = start - dt.timedelta(days=ATTRIBUTION_WINDOW_DAYS)
    # Iceberg answers min() from file statistics: no data is read.
    earliest = spark.sql(f"SELECT min(event_time) AS t FROM {archive}").first().t
    if earliest is None or earliest.date() > context_start:
        message = f"the archive starts at {earliest}, after {context_start}: the first week's basket additions may miss their clicks"
        if not allow_partial_context:
            raise SystemExit(message + " (pass --allow-partial-context to run anyway)")
        print(f"warning: {message}")

    scope = f"AND tenant_id IN ({', '.join(repr(t) for t in tenants)})" if tenants else ""
    # The context range: clicks from 7 days before the range, sessions that run past its end.
    spark.sql(f"""
        SELECT event_id, event_name, campaign_id, product_id, user_id, tenant_id, event_time,
               -- Rows archived before these columns existed: the live pipeline's defaults.
               coalesce(client_type, 'web') AS client_type, coalesce(user_type, 'visitor') AS user_type
        FROM (
            SELECT *, row_number() OVER (PARTITION BY tenant_id, event_id ORDER BY ingested_at DESC) AS copy
            FROM {archive}
            WHERE event_time >= TIMESTAMP '{context_start}' AND event_time < TIMESTAMP '{end + dt.timedelta(days=1)}' {scope}
        )
        WHERE copy = 1""").createOrReplaceTempView("ev")
    in_range = lambda column="event_time": f"{column} >= TIMESTAMP '{start}' AND {column} < TIMESTAMP '{end}'"  # noqa: E731

    # Last click: every click by the same user on the same product in the 7 days
    # before the basket addition; the latest (time, then ID) wins.
    spark.sql(f"""
        SELECT tenant_id, basket_id, product_id, user_id, user_type, client_type, event_time, click_id, campaign_id
        FROM (
            SELECT b.tenant_id, b.event_id AS basket_id, b.product_id, b.user_id, b.user_type, b.client_type, b.event_time,
                   c.event_id AS click_id, c.campaign_id,
                   row_number() OVER (PARTITION BY b.tenant_id, b.event_id ORDER BY c.event_time DESC, c.event_id DESC) AS rank
            FROM ev AS b
            JOIN ev AS c
              ON b.tenant_id = c.tenant_id AND b.user_id = c.user_id AND b.product_id = c.product_id
             AND c.event_time <= b.event_time AND b.event_time <= c.event_time + INTERVAL {ATTRIBUTION_WINDOW_DAYS} DAYS
            WHERE b.event_name = 'add_to_cart' AND b.product_id IS NOT NULL AND b.user_id IS NOT NULL
              AND c.event_name = 'click' AND c.campaign_id IS NOT NULL AND c.product_id IS NOT NULL
              AND {in_range('b.event_time')}
        )
        WHERE rank = 1""").createOrReplaceTempView("winners")

    written = {}
    written["event_totals"] = write(spark, namespace(), "event_totals", f"""
        SELECT '{run_id}' AS run_id, day, tenant_id, campaign_id,
               sum(i) AS total_impressions, sum(iw) AS total_web_impressions, sum(im) AS total_mobile_impressions,
               sum(c) AS total_clicks, sum(cw) AS total_web_clicks, sum(cm) AS total_mobile_clicks,
               sum(b) AS total_click_to_basket, sum(bw) AS total_web_click_to_basket, sum(bm) AS total_mobile_click_to_basket
        FROM (
            SELECT to_date(event_time) AS day, tenant_id, campaign_id,
                   count(DISTINCT CASE WHEN event_name = 'impression' THEN event_id END) AS i,
                   count(DISTINCT CASE WHEN event_name = 'impression' AND client_type = 'web' THEN event_id END) AS iw,
                   count(DISTINCT CASE WHEN event_name = 'impression' AND client_type = 'mobile' THEN event_id END) AS im,
                   count(DISTINCT CASE WHEN event_name = 'click' THEN event_id END) AS c,
                   count(DISTINCT CASE WHEN event_name = 'click' AND client_type = 'web' THEN event_id END) AS cw,
                   count(DISTINCT CASE WHEN event_name = 'click' AND client_type = 'mobile' THEN event_id END) AS cm,
                   0L AS b, 0L AS bw, 0L AS bm
            FROM ev WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL AND {in_range()}
            GROUP BY 1, 2, 3
            UNION ALL
            -- Once per winning click and product, under the basket addition's client type.
            SELECT to_date(event_time), tenant_id, campaign_id, 0L, 0L, 0L, 0L, 0L, 0L,
                   count(DISTINCT click_id, product_id),
                   count(DISTINCT CASE WHEN client_type = 'web' THEN click_id END, CASE WHEN client_type = 'web' THEN product_id END),
                   count(DISTINCT CASE WHEN client_type = 'mobile' THEN click_id END, CASE WHEN client_type = 'mobile' THEN product_id END)
            FROM winners GROUP BY 1, 2, 3
        )
        GROUP BY day, tenant_id, campaign_id""", run_id)

    written["customer_days"] = write(spark, namespace(), "customer_days", f"""
        SELECT DISTINCT '{run_id}' AS run_id, to_date(event_time) AS day, tenant_id, campaign_id, user_id,
               event_name AS metric, client_type, user_type
        FROM ev WHERE event_name IN ('impression', 'click') AND campaign_id IS NOT NULL AND user_id IS NOT NULL AND {in_range()}
        UNION
        SELECT DISTINCT '{run_id}', to_date(event_time), tenant_id, campaign_id, user_id, 'click_to_basket', client_type, user_type
        FROM winners""", run_id)

    # Sessions: a user's events split wherever the gap is 6 hours or more, kept by
    # the day they start. A session starting before the context range (more than
    # 7 days before the range) is seen only from that point.
    written["sessions"] = write(spark, namespace(), "sessions", f"""
        SELECT '{run_id}' AS run_id, to_date(min(event_time)) AS day, tenant_id, user_id,
               CASE WHEN max(CASE WHEN user_type = 'registered' THEN 1 ELSE 0 END) = 1 THEN 'registered' ELSE 'visitor' END AS user_type,
               min(event_time) AS session_start, max(event_time) AS last_event_time,
               count(*) AS events,
               sum(CASE WHEN event_name = 'impression' THEN 1 ELSE 0 END) AS impressions,
               sum(CASE WHEN event_name = 'click' THEN 1 ELSE 0 END) AS clicks,
               sum(CASE WHEN event_name = 'add_to_cart' THEN 1 ELSE 0 END) AS add_to_carts,
               max(client_type = 'web') AS web, max(client_type = 'mobile') AS mobile,
               array_sort(collect_set(CASE WHEN event_name IN ('impression', 'click') THEN campaign_id END)) AS campaigns,
               array_sort(collect_set(CASE WHEN event_name = 'click' THEN concat(campaign_id, ':', product_id) END)) AS clicked,
               array_sort(collect_set(CASE WHEN event_name = 'add_to_cart' THEN product_id END)) AS added
        FROM (
            SELECT *, sum(new_session) OVER (PARTITION BY tenant_id, user_id ORDER BY event_time, event_id ROWS UNBOUNDED PRECEDING) AS session
            FROM (
                SELECT *, CASE WHEN lag(event_time) OVER (PARTITION BY tenant_id, user_id ORDER BY event_time, event_id) IS NULL
                                 OR event_time >= lag(event_time) OVER (PARTITION BY tenant_id, user_id ORDER BY event_time, event_id) + INTERVAL {SESSION_GAP_HOURS} HOURS
                               THEN 1 ELSE 0 END AS new_session
                FROM ev WHERE user_id IS NOT NULL
            )
        )
        GROUP BY tenant_id, user_id, session
        HAVING {in_range('min(event_time)')}""", run_id)
    return written


def namespace() -> str:
    return os.environ.get("BACKFILL_NAMESPACE", "backfill")


def run_name(value: str) -> str:
    """An Airflow run ID as a plain partition value."""
    return re.sub(r"[^A-Za-z0-9_]", "_", value)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-id", required=True, type=run_name)
    parser.add_argument("--from", dest="start", required=True, type=dt.date.fromisoformat, help="first UTC day, YYYY-MM-DD")
    parser.add_argument("--to", dest="end", required=True, type=dt.date.fromisoformat, help="day after the last one, YYYY-MM-DD")
    parser.add_argument("--tenants", default="all", type=parse_tenants)
    parser.add_argument("--allow-partial-context", action="store_true")
    args = parser.parse_args()
    session = spark_session()
    try:
        print(f"backfill run {args.run_id}: {backfill(session, args.run_id, args.start, args.end, args.tenants, args.allow_partial_context)}")
    finally:
        session.stop()
