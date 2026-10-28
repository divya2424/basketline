import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext.jsx'

/**
 * The store, cart and dashboard exist only inside a tenant: you get there by
 * signing in from the onboarding page. Signed out, they redirect to it. A
 * restored session always belongs to the current tenant (sessionStorage.js).
 */
export function RequireTenant({ children }) {
  const { user } = useAuth()
  return user ? children : <Navigate to="/" replace />
}
