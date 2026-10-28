import { useState } from 'react'
import { Button } from '../../components/common/Button.jsx'
import { trackEvent } from '../../analytics/analytics.js'
import { EVENT_NAMES } from '../../analytics/eventSchema.js'
import { useAuth } from './AuthContext.jsx'
import { ROLE_LABELS } from './authService.js'
import { LoginModal } from './LoginModal.jsx'

/**
 * Renders children only for users with `role`. Children aren't rendered
 * otherwise, so a lazy page behind this guard isn't even downloaded.
 * This is a UI gate, not a security boundary: the API must check roles too.
 */
export function RequireRole({ role, pageName, children }) {
  const { user } = useAuth()
  const [loginOpen, setLoginOpen] = useState(false)

  if (user?.role === role) return children

  const openLogin = () => {
    setLoginOpen(true)
    trackEvent({ featureName: 'access_gate', pageName, eventName: EVENT_NAMES.LOGIN_CLICK, properties: {} })
  }

  return (
    <div className="container page">
      <div className="empty-state">
        <h1>Access restricted</h1>
        {user ? (
          <p>
            This page is only available to {ROLE_LABELS[role].toLowerCase()}s. You are signed in as a{' '}
            {ROLE_LABELS[user.role]?.toLowerCase() ?? 'user'}.
          </p>
        ) : (
          <>
            <p>Sign in with a {ROLE_LABELS[role].toLowerCase()} account to view this page.</p>
            <Button onClick={openLogin}>Sign in</Button>
          </>
        )}
      </div>
      {loginOpen ? <LoginModal onClose={() => setLoginOpen(false)} /> : null}
    </div>
  )
}
