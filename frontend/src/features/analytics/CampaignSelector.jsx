export const ALL_CAMPAIGNS = 'all'

export function CampaignSelector({ campaigns, value, onChange }) {
  return (
    <div className="field">
      <label htmlFor="campaign-select">Campaign</label>
      <select id="campaign-select" value={value} onChange={(event) => onChange(event.target.value)}>
        {campaigns.map((campaign) => (
          <option key={campaign.id} value={campaign.id}>
            {campaign.title}
          </option>
        ))}
        <option value={ALL_CAMPAIGNS}>Compare all campaigns</option>
      </select>
    </div>
  )
}
