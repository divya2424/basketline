import { useMemo, useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import { analyticsApi } from './analyticsService.js'
import { ALL_CAMPAIGNS, CampaignSelector } from './CampaignSelector.jsx'
import { CampaignMetricsPanel } from './CampaignMetricsPanel.jsx'
import { CampaignComparison } from './CampaignComparison.jsx'
import { TimeRangeSelector } from './TimeRangeSelector.jsx'
import { ApiKeysPanel } from '../integration/ApiKeysPanel.jsx'
import { DEFAULT_TIME_RANGE, formatRangeLabel, toPeriod } from './timeRange.js'
import './analytics.css'

export function AnalyticsPage({ api = analyticsApi, campaigns: campaignsProp }) {
  // Campaigns come from the catalog (active campaigns from the API) unless passed in.
  const catalog = useCatalog()
  const campaigns = campaignsProp ?? catalog.campaigns
  const [pickedId, setPickedId] = useState(null)
  // Until the user picks one, show the first campaign (the list may still be loading).
  const selectedId = pickedId ?? campaigns[0]?.id ?? ALL_CAMPAIGNS
  const selected = campaigns.find((campaign) => campaign.id === selectedId)
  const [range, setRange] = useState(DEFAULT_TIME_RANGE)
  const period = useMemo(() => toPeriod(range), [range])

  return (
    <div className="container page analytics-page">
      <div className="analytics-header">
        <div>
          <h1>Campaign Analytics</h1>
          <p className="muted">Ad impressions, clicks and cart additions per campaign.</p>
        </div>
        <DataSourceBadge api={api} />
      </div>

      {!campaignsProp && catalog.status === 'loading' ? (
        <p className="loading-banner" role="status">
          <Spinner size="sm" /> Loading campaigns…
        </p>
      ) : !campaignsProp && catalog.status === 'error' ? (
        <div className="empty-state" role="alert">
          <p>Couldn’t load campaigns: {catalog.error?.message}</p>
          <Button onClick={catalog.reload}>Try again</Button>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="empty-state">
          <p>No campaigns to report on yet.</p>
        </div>
      ) : (
        <>
          <div className="analytics-toolbar">
            <CampaignSelector campaigns={campaigns} value={selectedId} onChange={setPickedId} />
            <TimeRangeSelector value={range} onChange={setRange} />
            {selected?.description ? <p className="muted">{selected.description}</p> : null}
          </div>
          <p className="muted analytics-period" data-testid="analytics-period">
            Showing {formatRangeLabel(range)}
          </p>
          {selectedId === ALL_CAMPAIGNS ? (
            <CampaignComparison key={`${period.from}|${period.to ?? ''}`} api={api} campaigns={campaigns} period={period} />
          ) : (
            // Keyed so switching campaigns or ranges starts from a clean loading state.
            <CampaignMetricsPanel
              key={`${selectedId}|${period.from}|${period.to ?? ''}`}
              api={api}
              campaignId={selectedId}
              campaignTitle={selected?.title}
              period={period}
            />
          )}
        </>
      )}
      <ApiKeysPanel />
    </div>
  )
}

function DataSourceBadge({ api }) {
  if (api.mode === 'mock') {
    return (
      <p className="data-badge data-badge--mock" data-testid="data-source">
        <strong>Mock data</strong> — demo values, not from the analytics API
      </p>
    )
  }
  return (
    <p className="data-badge data-badge--live" data-testid="data-source">
      <strong>Live API</strong> {api.baseUrl ? `— ${api.baseUrl}` : '— same-origin /ad/…'}
    </p>
  )
}
