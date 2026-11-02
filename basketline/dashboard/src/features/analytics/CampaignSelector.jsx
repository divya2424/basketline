export const ALL_CAMPAIGNS = 'all'
export const ALL_STORES = 'all'
/** The store of events sent without one. */
const NO_STORE = '00000000-0000-0000-0000-000000000000'

export function CampaignSelector({ campaigns, value, onChange }) {
  return (
    <div className="field">
      <label htmlFor="campaign-select">Campaign</label>
      <select id="campaign-select" value={value} onChange={(event) => onChange(event.target.value)}>
        {campaigns.map((campaign) => (
          <option key={campaign.id} value={campaign.id}>
            {campaign.id}
          </option>
        ))}
        <option value={ALL_CAMPAIGNS}>Compare all campaigns</option>
      </select>
    </div>
  )
}

export function StoreSelector({ stores, value, onChange }) {
  return (
    <div className="field">
      <label htmlFor="store-select">Store</label>
      <select id="store-select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL_STORES}>All stores</option>
        {stores.map((storeId) => (
          <option key={storeId} value={storeId}>
            {storeId === NO_STORE ? 'No store' : storeId}
          </option>
        ))}
      </select>
    </div>
  )
}
