import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { useAuth } from './AuthContext.jsx'

/**
 * onSignedIn(user), when given, is called after a successful sign-in instead of
 * onClose (the onboarding page reloads the app for the chosen store).
 */
export function LoginModal({ onClose, onSignedIn, title = 'Sign in' }) {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const usernameRef = useRef(null)
  const id = useId()

  useEffect(() => {
    usernameRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const user = await login(username, password)
      if (onSignedIn) onSignedIn(user)
      else onClose()
    } catch (loginError) {
      setError(loginError.message || 'Sign-in failed. Try again.')
      setPassword('')
      setPending(false)
    }
  }

  // Portal to <body>: the sticky header's backdrop-filter would otherwise
  // become the containing block for this fixed overlay.
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <form className="login-form" onSubmit={handleSubmit} noValidate aria-busy={pending}>
          <div className="form-field">
            <label htmlFor={`${id}-username`}>Username</label>
            <input
              ref={usernameRef}
              id={`${id}-username`}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck="false"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={pending}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-password`}>Password</label>
            <input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="login-form__actions">
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Spinner size="sm" className="spinner--on-primary" />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
