import { useState } from 'react'
import { Button } from '../../components/common/Button.jsx'

/** Copies text; resolves false where the clipboard isn't available (the text stays selectable). */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A value with a Copy button. */
export function CopyField({ label, value, testId }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-field">
      <span className="copy-field__label">{label}</span>
      <code className="copy-field__value" data-testid={testId}>
        {value}
      </code>
      <Button
        variant="secondary"
        size="sm"
        aria-label={`Copy ${label}`}
        onClick={async () => setCopied(await copy(value))}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/** A new API key, shown once: Basketline keeps only its hash. */
export function KeyReveal({ apiKey }) {
  return (
    <div className="key-reveal" role="note">
      <CopyField label={`API key "${apiKey.name}"`} value={apiKey.key} testId="api-key-secret" />
      <p className="key-reveal__warning">
        <strong>Copy it now:</strong> it won’t be shown again. Keep it on your server: it lets your backend vouch for your
        signed-in shoppers.
      </p>
    </div>
  )
}
