# Real-time dashboard for an advertising analytics platform

**Research and recommendation for Basketline**  
Prepared 1 November 2026

## Executive recommendation

Build a campaign dashboard that separates **live delivery**, **provisional outcomes**, and **settled results**. Refreshing a page every few seconds does not make every metric equally current or final. Impressions and clicks are close to the event source; purchase attribution, unique reach, invalid-traffic adjustments, and financial metrics can arrive or be corrected later.

The first screen should help a marketer answer, in order:

1. Is the campaign delivering right now?
2. Are shoppers engaging, and which products are driving that engagement?
3. Are those engagements turning into baskets and purchases?
4. Can I trust and compare this period’s numbers yet?

The dashboard should show metric freshness and status beside the numbers, expose the attribution definition, and avoid presenting click-to-basket as a sale. The IAB/MRC retail media guidance calls for transparent methods and granular reporting, including SKU-level reporting where relevant, and distinguishes attributed sales from other outcome and category measures. [IAB/MRC Retail Media Measurement Guidelines](https://www.iab.com/wp-content/uploads/2024/01/IAB_Retail_Media_Measurement_Guidelines_January2024.pdf) · [Guidelines explainer](https://www.iab.com/wp-content/uploads/2024/01/IAB-MRC-Retail-Media-Measurement-Guidelines-Explainer-January-2024.pdf)

## Proposed dashboard layout

```text
┌ Campaign: [All campaigns ▾] [Status ▾] [Date/time ▾] [UTC ▾] [Refresh: 20s]
│ Data through 10:42:15 UTC · Events 18s behind · Attribution provisional
├────────────────────────────────────────────────────────────────────────────┤
│ Impressions       Clicks           CTR              Spend*        Pacing*  │
│ 1.24M             18,420           1.48%            $4,210        62%      │
│ live              live             derived/live     near-live     near-live│
├──────────────────────────────────────┬─────────────────────────────────────┤
│ Delivery & outcomes over time        │ Funnel                              │
│ impressions / clicks / spend         │ impressions → clicks → baskets     │
│ selectable hourly / daily grain      │ → orders (if integrated)           │
├──────────────────────────────────────┴─────────────────────────────────────┤
│ Product performance: product | seller | impressions | clicks | CTR |       │
│ baskets | orders | sales | spend | ROAS | status / last updated            │
│ sort, search, filter, paginate; include zero-activity campaign products    │
├────────────────────────────────────────────────────────────────────────────┤
│ Diagnostics: event volume · late/duplicate/invalid rate · source lag       │
│ Definitions & attribution: click-through window, model, currency, timezone │
└────────────────────────────────────────────────────────────────────────────┘
*Only show spend/pacing if campaign budgets and billable cost data are actually integrated.
```

### Page structure

1. **Scope bar:** tenant (implicit from authorization), campaign or all campaigns, campaign status, seller, date range, timezone, and refresh control. Default the live view to “Today so far,” with hourly trend and a visible timezone. Provide historical presets separately.
2. **KPI strip:** impressions, clicks, CTR, spend and budget pacing when available; add-to-cart and purchase outcomes should be shown as a second outcome group so a marketer can distinguish delivery from business result.
3. **Trend and funnel:** time series for impressions, clicks, and spend; funnel for impressions → clicks → add-to-cart → orders. Each chart should allow an hourly/daily grain and annotate incomplete periods.
4. **Product leaderboard:** product and seller rows with metrics, sortable and filterable. Include the campaign’s attached products with zero activity when requested, rather than silently omitting them. Fetch labels from the retailer-owned catalog or Basketline’s campaign-product projection in batches; join to metric rows by stable IDs.
5. **Breakdowns:** placement/ad format, device, web/mobile, seller, product/category, and audience segment only where collected, permitted, and statistically useful. IAB/MRC recommends reporting dimensions such as time, campaign, audience, device, format, cost, and SKU-level outcomes where relevant; disclose coverage and methodology.
6. **Trust and diagnostics:** show last event time, end-to-end lag, processing/attribution status, data-quality warnings, and links to metric definitions. Don’t bury “provisional” in a tooltip.

## Which metrics belong in each freshness tier?

The latency bands below are **recommended Basketline product targets**, not industry guarantees. Measure freshness end to end from source event time and ingestion time through the API; publish observed p50/p95, not just a configured refresh interval.

| Dashboard tier | Target to design for | Metrics | How to label it |
|---|---:|---|---|
| **Live delivery** | p95 within 1 minute of event receipt; UI refresh 15–30 seconds | Impression events, click events, CTR derived from those counts; optionally ad requests/fills if instrumented | “Live, provisional”; show “data through” and lag |
| **Near-real-time outcomes** | p95 within 5–15 minutes after the required events arrive | Add-to-cart events; attributed add-to-cart under a named click-through model/window; product-level engagement rankings | “Attribution processing”; counts may change as late events arrive |
| **Settled reporting** | Hourly reconciliation, with a defined finalization/adjustment window | De-duplicated / invalid-traffic-adjusted counts; finalized attributed orders, units, sales, ROAS, new-to-brand, unique reach/frequency | “Updated at”; show attribution window and correction policy |
| **Delayed / analytical** | Daily or scheduled | Sessions, repeat purchase, category share, incrementality, offline/omnichannel outcomes, cohort and cross-campaign analysis | “Daily” or “modeled”; disclose method, lag, and limitations |

These bands are design goals. Real ad platforms also distinguish freshness by metric: Google says most clicks, impressions, and cost have a one-hour freshness SLO, while reach is daily and conversion freshness varies; it also describes post-event adjustments from invalid traffic and late conversions. Amazon Ads documentation says campaign reporting data is updated multiple times a day, with many metrics refreshed every 3–6 hours in the cited help page, and some validation can affect counts later. This is a reminder to set and communicate your own SLO instead of promising that every ad metric is exact instantly. [Google Ads data freshness](https://support.google.com/google-ads/answer/2544985?hl=en-en) · [Amazon Ads reporting freshness](https://advertising.amazon.ca/help/G39GZAGKT4VDL6UM) · [Amazon Ads validation note](https://advertising.amazon.co.uk/help/G8WCYU3FQKFVSMR4)

### Metric definitions and availability

| Metric | Meaning / calculation | Freshness and caveat | Basketline today |
|---|---|---|---|
| **Impressions** | Count of valid ad impression events under the platform’s counting rule | Live event count can be provisional; later filtering or deduplication may revise it. An impression is not automatically viewable. | Supported for campaign; current event-based count |
| **Viewable impressions / viewability rate** | Impressions meeting the applicable viewability measurement standard; viewable ÷ measurable impressions | Requires viewport/ad-format measurement signals and disclosed methodology. Don’t infer viewability from an SDK impression event. | Not currently implemented |
| **Clicks** | Count of valid click events under a documented click rule | Live event count; may be deduplicated/filtered later. Distinguish ad click from generic product click. | Supported for campaign |
| **CTR** | Clicks ÷ impressions × 100 | Derived; display `—` when denominator is zero. Low-volume CTR is noisy. | Frontend derives it from counts |
| **Add-to-cart events** | Number of cart additions, optionally distinct cart actions/products/orders | A raw cart event is not necessarily ad-attributed and is not a purchase. | Events are captured; reported metric is attributed click-to-basket |
| **Click-to-basket** | Basket addition credited to a prior click on the same product under an explicit model/window | Provisional while late clicks/baskets can still change the winner. This is an intent signal, not conversion revenue. | Supported; last eligible click for same user/product within 7 days |
| **Orders / units / sales** | Retailer-confirmed completed order, units, and net/gross sales under a clear cancellation/return policy | Often near-real-time initially, then corrected for late order feeds, cancellations, returns, and attribution. | Not currently supported; add a purchase/order integration before claiming sales performance |
| **ROAS** | Attributed sales value ÷ ad spend | Meaningless without cost coverage, currency, sales definition, and attribution disclosure. Recent periods can look artificially weak before conversions settle. | Not currently supported; spend and purchase value are not in the existing metric contract |
| **Unique reach / frequency** | Distinct eligible people reached; impressions ÷ reach | Identity resolution and privacy thresholds matter; de-duplication is usually delayed and may be approximate. Frequency is not impressions per SDK user unless identity coverage is disclosed. | Unique customers available; estimates can be approximate, not a validated cross-device reach metric |
| **Sessions** | Visit/session count and derived engagement/conversion rate | A session is not instantaneous until its inactivity boundary has passed. | Supported; session is built after 6 hours idle and surfaced roughly 7 hours after end |
| **New-to-brand, repeat, category share, incrementality** | Outcome / audience measures requiring historical purchase and/or control/baseline data | Daily or longer; these are not stream counters. Incrementality is causal/model-based and needs experimental design or a defensible model. | Not currently supported |

The IAB/MRC guideline identifies attributed direct sales/ROAS/conversions, new-buyer measures, repeat/frequency, halo/assisted outcomes, digital shelf share, and incrementality as useful retail media outcome measures, but emphasizes transparent definitions and methods. It recommends SKU-level reporting where relevant and disclosing attribution windows; it notes common digital windows such as 3, 7, 14, 28, or 30 days while stating the selected window should be empirically supported and applied consistently. [IAB/MRC Retail Media Measurement Guidelines](https://mediaratingcouncil.org/sites/default/files/Standards/IAB_Retail_Media_Measurement_Guidelines_January2024.pdf)

## What is actually actionable in real time?

**Good for live optimization:** delivery volume, click volume, CTR after enough impressions, spend/budget pacing if cost data is current, broken-tag or ingestion alerts, and product-level engagement leaders. These help detect a campaign that stopped delivering, a broken integration, a placement with an unusual response, or a product attracting clicks.

**Use caution for very recent data:** add-to-cart attribution, order conversion rate, CPA, and ROAS. Those depend on conversion lag and matching. Show the event-time range and attribution window; mark the current period as incomplete and let the user compare with a mature period. Google explicitly notes that recent periods may understate conversions and ROAS / overstate CPA while conversions are still arriving, and provides conversion-lag reporting for that reason. [Google Ads conversion lag](https://support.google.com/google-ads/answer/9347141?hl=en-GB) · [Google Ads conversion timing](https://support.google.com/google-ads/answer/6270625?hl=en_us_us)

**Not a simple live counter:** incrementality, category share growth, new-to-brand, and cross-retailer halo. These require comparison populations, history, retailer sales data, or modeling. Show them in a separate analysis/report area with methodology, not as live streaming KPIs.

## Basketline-specific fit and gaps

The current frontend already has a useful campaign funnel: impressions → clicks → click-to-basket, CTR, audience splits, sessions, campaign selection, and date ranges. It also labels sessions as delayed. The backend provides tenant/seller-scoped campaign metrics from ClickHouse daily aggregates. Its code documents that today’s figures are live, the hourly check reconciles event counts, customer/session estimates can be approximate at higher cardinalities, and sessions are about seven hours behind. [Analytics page](../frontend/src/features/analytics/AnalyticsPage.jsx) · [Campaign metrics panel](../frontend/src/features/analytics/CampaignMetricsPanel.jsx) · [Metrics service](../backend/services/analytics-service/src/services/metrics.service.ts)

For the assignment, describe the current experience as **near-real-time campaign analytics**, not fully real-time sales analytics. The system has streaming ingestion and processing, but the metrics are not all at event-time freshness and the current contract has no spend, order, sales, or ROAS measures.

Recommended next additions:

1. Add a top-level freshness banner: `data through`, pipeline lag, refreshed time, and provisional/final status. Derive it from event time, ingestion time, Flink watermark/checkpoint health, and ClickHouse freshness—not a hard-coded clock.
2. Add an hourly trend and a paginated product table using `(tenant_id, campaign_id, product_id, hour/day)` metrics. Join only the campaign’s attached products for zero-activity rows, and resolve names in a batch from the retailer-backed projection.
3. Add a server-side order/purchase event contract with stable `order_id`, line-item `product_id`, event/received time, value, currency, cancellation/refund adjustments, and deduplication key. Do not report ROAS until spend and sales semantics are agreed.
4. Keep provisional and settled numbers distinct. Show click-to-basket with the current seven-day last-click rule; later add purchases with their own disclosed attribution model/window. Avoid silently mixing models.
5. Add product-level and seller-level filters, web/mobile, placement, and category only where Basketline actually receives those fields and the data is sufficiently complete.
6. Add diagnostics for event acceptance/rejection, duplicate rate, late-event rate, Kafka consumer lag, Flink backpressure/checkpoint age, ClickHouse ingestion lag, and reference-data freshness. Surface an actionable incident when freshness breaches its SLO.

## Metric presentation rules

- Every KPI should have a plain-language definition, numerator/denominator where relevant, event-time basis, timezone, attribution window/model, and data status.
- Keep **event counts** separate from **unique people**. One shopper can generate multiple clicks or add-to-cart events. Name the metric “click events” if that is what is counted; reserve “customers who clicked” for a distinct-user count.
- Do not display CTR or conversion rates when denominators are zero; mark low-volume rates as directional.
- Show “0” only when the source is healthy and the complete period was observed. Show “No data” or a freshness warning when instrumentation/pipeline health is unknown.
- A product leaderboard should include metric selection and sorting. Don’t label a product “best performing” based on clicks alone; expose the selected objective (engagement, baskets, purchases, revenue, or ROAS).
- Make historical corrections visible: retain event date for attribution reporting, expose updated-at, and explain that totals can be adjusted for late events, duplicate filtering, or invalid traffic.
- Apply tenant authorization in every query and export. Avoid exposing shopper-level event trails or direct personal identifiers in the dashboard.

## Sources

- [IAB/MRC Retail Media Measurement Guidelines (January 2024)](https://www.iab.com/wp-content/uploads/2024/01/IAB_Retail_Media_Measurement_Guidelines_January2024.pdf)
- [IAB/MRC Guidelines Explainer](https://www.iab.com/wp-content/uploads/2024/01/IAB-MRC-Retail-Media-Measurement-Guidelines-Explainer-January-2024.pdf)
- [Google Ads: About data freshness](https://support.google.com/google-ads/answer/2544985?hl=en-en)
- [Google Ads: About conversion lag reporting](https://support.google.com/google-ads/answer/9347141?hl=en-GB)
- [Google Ads: Understand conversion tracking data and conversion time](https://support.google.com/google-ads/answer/6270625?hl=en_us_us)
- [Amazon Ads: Campaign reporting](https://advertising.amazon.com/measurement-analytics/campaign-reporting)
- [Amazon Ads: Reporting data update frequency](https://advertising.amazon.ca/help/G39GZAGKT4VDL6UM)
- [Amazon Ads: Campaign metric validation timing](https://advertising.amazon.co.uk/help/G8WCYU3FQKFVSMR4)
