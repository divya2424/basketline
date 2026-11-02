import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { authenticate, endSession } from './authService.js'
import { loadSession, saveSession } from './sessionStorage.js'
import { setRequestUser } from '../../api/requestContext.js'
import { setUnauthorizedHandler } from '../../api/httpClient.js'

const AuthContext = createContext(null)

export function AuthProvider({ children, initialUser, persist = true }) {
  const [user, setUser] = useState(() => {
    const restored = initialUser !== undefined ? initialUser : persist ? loadSession() : null
    // Synchronous, not in an effect: child effects (e.g. the first API calls)
    // run before this provider's effects and must already send the token.
    setRequestUser(restored)
    return restored
  })

  /** Local sign-out (token expired, revoked, or the user logged out). */
  const clearSession = useCallback(() => {
    setRequestUser(null)
    setUser(null)
    if (persist) saveSession(null)
  }, [persist])

  const login = useCallback(
    async (username, password) => {
      const nextUser = await authenticate(username, password)
      setRequestUser(nextUser)
      setUser(nextUser)
      if (persist) saveSession(nextUser)
      return nextUser
    },
    [persist],
  )

  const logout = useCallback(async () => {
    await endSession()
    clearSession()
  }, [clearSession])

  // A 401 on a request that carried our token means it expired or was revoked.
  useEffect(() => {
    setUnauthorizedHandler(clearSession)
    return () => setUnauthorizedHandler(() => {})
  }, [clearSession])

  // Sign out when the 30-minute token expires.
  const expiresAt = user?.expiresAt
  useEffect(() => {
    if (!expiresAt) return undefined
    const timer = setTimeout(clearSession, Math.max(0, Date.parse(expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt, clearSession])

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
