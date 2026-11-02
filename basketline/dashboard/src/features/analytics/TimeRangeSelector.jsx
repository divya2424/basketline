import { useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { TIME_RANGE_PRESETS, rangeDays, utcToday, validateCustomRange } from './timeRange.js'

const CUSTOM = 'custom'

/**
 * Preset ranges apply as soon as they're picked. A custom range is edited in two
 * date fields and applied with the button, so typing a date sends no requests.
 */
export function TimeRangeSelector({ value, onChange }) {
  const [editingCustom, setEditingCustom] = useState(Boolean(value.custom))
  const [draft, setDraft] = useState(() => rangeDays(value))
  const today = utcToday()
  const error = validateCustomRange(draft.from, draft.to)

  const choose = (choice) => {
    if (choice === CUSTOM) {
      setDraft(rangeDays(value))
      setEditingCustom(true)
    } else {
      setEditingCustom(false)
      onChange({ preset: choice })
    }
  }

  return (
    <>
      <div className="field">
        <label htmlFor="time-range-select">Time range (UTC days)</label>
        <select id="time-range-select" value={editingCustom ? CUSTOM : value.preset} onChange={(event) => choose(event.target.value)}>
          {TIME_RANGE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom range…</option>
        </select>
      </div>
      {editingCustom ? (
        <form
          className="time-range-custom"
          onSubmit={(event) => {
            event.preventDefault()
            if (!error) onChange({ custom: draft })
          }}
        >
          <div className="field">
            <label htmlFor="time-range-from">From</label>
            <input
              id="time-range-from"
              type="date"
              max={today}
              value={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="time-range-to">To</label>
            <input
              id="time-range-to"
              type="date"
              max={today}
              value={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            />
          </div>
          <Button type="submit" disabled={Boolean(error)}>
            Apply
          </Button>
          {error ? (
            <p className="form-error time-range-custom__error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </>
  )
}
