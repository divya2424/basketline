# Technical Leadership Round: Interview Prep

This guide maps the assignment to the Basketline implementation in this repository. Be explicit about which parts are implemented and which are production-scale extensions.

## Architecture and deployment flow

```mermaid
flowchart LR
  subgraph Retailer[Retailer boundary]
    Store[Retailer storefront]
    SDK[Browser event SDK]
    Store --> SDK
  end

  subgraph Edge[Platform edge and services]
    LB[Load balancer / ingress]
    GW[API gateway\nJWT, tenant context, rate limits]
    Ingest[Analytics ingestion API\nschema validation, event ID]
    Auth[Auth service]
    Product[Product service]
    Campaign[Campaign service]
    Store --> LB --> GW
    GW --> Ingest
    GW --> Auth
    GW --> Product
    GW --> Campaign
  end

  subgraph Stream[Streaming plane]
    Kafka[(Kafka topics\npartitioned by tenant + entity key)]
    Flink[Flink\nevent-time, dedupe, attribution, sessions]
    DLQ[(Quarantine / DLQ)]
    Ingest --> Kafka
    Auth -. domain events .-> Kafka
    Product -. domain events .-> Kafka
    Campaign -. domain events .-> Kafka
    Kafka --> Flink
    Flink --> DLQ
  end

  subgraph Data[Data plane]
    CH[(ClickHouse\nreal-time aggregates and query tables)]
    Iceberg[(Iceberg tables on S3\nraw event history)]
    PG[(Per-service Postgres\nconfiguration and identities)]
    Flink --> CH
    Flink --> Iceberg
    Auth --> PG
    Product --> PG
    Campaign --> PG
  end

  subgraph Serving[Insights and operations]
    API[Insights API\n/ad/:campaignId/{clicks,impressions,clickToBasket}]
    Dashboard[Retailer / marketer dashboard]
    Airflow[Airflow\ncompaction, retention, backfill]
    Obs[Metrics, logs, traces, alerts]
    CH --> API --> GW
    GW --> Dashboard
    Iceberg --> Airflow
    Airflow --> CH
    Edge -. telemetry .-> Obs
    Stream -. telemetry .-> Obs
    Data -. telemetry .-> Obs
  end
```

### How to narrate the flow

1. The retailer SDK emits versioned, tenant-scoped events with an event ID, event time, anonymous or authenticated shopper ID, campaign/ad/product IDs, and consent metadata.
2. The gateway authenticates the caller, resolves the tenant from trusted credentials, enforces quotas, and forwards to the ingestion API. The ingestion service validates and publishes to Kafka; it does not synchronously compute metrics.
3. Kafka buffers bursts and partitions events for parallelism. Flink validates/enriches, deduplicates by event ID, uses event time and watermarks for late data, maintains bounded state for sessions and click-to-basket attribution, and routes invalid records to quarantine.
4. Flink writes low-latency aggregate/query data to ClickHouse and durable raw events to Iceberg on S3. Airflow handles scheduled compaction, retention, and historical replay/backfill; it is not on the real-time path.
5. The Insights API applies tenant authorization and queries pre-aggregated ClickHouse tables for recent data. Historical requests can query longer-range aggregates, or the lakehouse through an asynchronous/reporting path when the requested window is too large.

## Likely interviewer questions

### Architecture and technology choices

- Draw the end-to-end architecture and identify the synchronous and asynchronous paths.
- Why Kafka instead of direct service calls, a queue, or a managed streaming service? What delivery guarantees do you get?
- Why Flink for processing? When would Kafka Streams, Spark Structured Streaming, or a cloud-native service be a better fit?
- Why ClickHouse for interactive analytics and Iceberg/S3 for raw history? What would make you choose DynamoDB/Cassandra, Snowflake, or a warehouse-first design?
- Where are the single points of failure? What are the availability objectives and failure behavior?
- What is the expected event rate, payload size, peak multiplier, API QPS, and freshness SLO? How do those numbers change the design?

### Ingestion and event contracts

- How do you handle malformed events, schema evolution, producer SDK upgrades, and incompatible changes?
- How do you prevent client retries from inflating metrics? What is the idempotency key and deduplication window?
- How do you protect ingestion from bots, abusive tenants, oversized payloads, and traffic spikes?
- What happens if Kafka is unavailable or a partition is behind? Can the SDK buffer events safely?
- How do you distinguish an impression from a unique customer impression? How do anonymous and logged-in identities join?

### Stateful processing and correctness

- How do event time, processing time, watermarks, and late events work in this design?
- Define click-to-basket attribution precisely: attribution window, eligible products, multiple clicks, multiple carts, and attribution model.
- What happens when click and add-to-cart arrive out of order? When can a result be revised?
- How are Flink state, checkpoints, savepoints, and recovery managed? How do you handle state growth and hot keys?
- What semantics are actually end-to-end: at-least-once or exactly-once? Which sink/connector guarantees are required?
- How do you reconcile streaming aggregates against the raw event archive?

### Storage, API, and performance

- What is the serving table grain and sort/partition key? How do you avoid expensive scans?
- Define the API contract for clicks, impressions, and click-to-basket: unique customers or event counts, filters, time zone, freshness, pagination, and empty results.
- How do APIs support both near-real-time and historical queries? How do you label freshness and handle corrected late data?
- How do you cache safely without leaking one tenant's response to another?
- What retention applies to raw events, aggregates, identity data, and backups? How are deletion and replay handled?
- How will you keep dashboard queries responsive under many concurrent tenants?

### Scalability and multi-tenancy

- How do you scale Kafka partitions and consumers/Flink parallelism? What requires repartitioning, and what is the migration plan?
- What key would you partition by, and how do you address a very large tenant or campaign hot key?
- How do you enforce tenant isolation in the API, stream, object storage, and analytical tables?
- How are tenant-specific schemas, quotas, retention, consent rules, and encryption keys configured?
- How do you prevent noisy neighbors while keeping shared infrastructure cost-effective?
- What is your plan for a major retail event (for example, a flash sale) that creates a 10x burst?

### Reliability, security, and operations

- Which SLIs/SLOs would you publish for ingestion, freshness, API latency, correctness, and availability?
- Which alerts detect consumer lag, backpressure, checkpoint failures, rejected events, storage growth, and query degradation?
- How do you trace an individual event from SDK through Kafka and Flink to an API result?
- How do you manage secrets, encryption in transit/at rest, PII minimization, consent, and data deletion?
- What is the disaster recovery plan, including Kafka durability, ClickHouse recovery, and Iceberg replay?
- How do you do safe deploys, schema migrations, Flink upgrades, rollback, and replay without double counting?

### Cost and trade-offs

- What are the largest cost drivers and how do you attribute them to tenants?
- How would you choose retention, replication, partition count, compaction frequency, and query freshness targets?
- What cost controls/alerts would you set up? How would you prove savings did not harm data quality or SLOs?
- Where do you deliberately accept eventual consistency, and where is stronger correctness required?
- What would you simplify first for an MVP, and what must be in place before production scale?

### Code walkthrough and leadership

- Walk through one endpoint from route to authorization, query construction, response schema, and error handling.
- How does the endpoint ensure tenant and campaign access is enforced in the data query itself?
- How would you test boundaries such as unknown campaigns, empty windows, duplicate events, late events, and ClickHouse timeouts?
- What would you change if the endpoint had to support arbitrary date ranges or millions of campaigns?
- Describe a design decision you changed after new evidence, a production incident you led, and how you aligned teams around an SLO or migration.
- How would you communicate a freshness/correctness incident to retailer and advertiser stakeholders?

## Strong answers to anchor on

- **Metric meaning first:** specify event counts versus unique customers; define identity, attribution window, timezone, and correction behavior before discussing SQL.
- **Tenant identity is trusted:** derive tenant scope from authenticated credentials and apply it to every API query and storage path; never trust a browser-supplied tenant ID by itself.
- **At-least-once plus idempotency:** assume retries and replay. Use stable event IDs, dedupe at bounded stages, and make backfills repeatable.
- **Two data horizons:** ClickHouse serves hot interactive aggregates; Iceberg/S3 keeps durable raw history for replay and long-range analysis.
- **Freshness is a product contract:** expose `asOf`/freshness metadata and set separate targets for live and historical results.
- **Cost follows cardinality and retention:** monitor bytes/event, state size, partitions, compaction, query scans, and per-tenant usage.

## Prep checklist

- Prepare a 5-minute architecture walkthrough and a 15-minute deep dive on attribution/state.
- Pick one endpoint in this repository and trace its auth, tenant scope, SQL, and tests before the interview.
- Have concrete assumptions ready for peak events/sec, latency/freshness SLO, retention, and recovery objectives; label them as assumptions until clarified.
- Be ready to explain current implementation limits and the next two production-hardening steps.
- Prepare one resume story each for technical judgment, operational ownership, cross-team leadership, and a measurable outcome.