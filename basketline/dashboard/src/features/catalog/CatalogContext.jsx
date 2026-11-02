import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { fetchCatalog } from './catalogService.js'
import { sharedRequest } from '../../api/sharedRequest.js'
import { useAuth } from '../auth/AuthContext.jsx'

const EMPTY = { status: 'ready', campaigns: [], error: null, reload: () => {} }
const CatalogContext = createContext(EMPTY)

/**
 * Loads the signed-in tenant's campaigns once for the whole app (again after
 * signing in as someone else). `initialCatalog` ({ campaigns }) skips the
 * request (tests, previews).
 */
export function CatalogProvider({ children, initialCatalog }) {
  const { user } = useAuth()
  const userId = user?.userId
  const [state, setState] = useState(() =>
    initialCatalog ? { status: 'ready', ...initialCatalog, error: null } : { status: 'loading', campaigns: [], error: null },
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (initialCatalog) return undefined
    if (!userId) {
      setState({ status: 'ready', campaigns: [], error: null })
      return undefined
    }
    let current = true
    setState((state) => ({ ...state, status: 'loading', error: null }))
    // Shared rather than aborted on cleanup, so StrictMode's dev re-mount doesn't cancel and resend it.
    sharedRequest(fetchCatalog, `${userId}:${attempt}`, () => fetchCatalog()).then(
      (catalog) => current && setState({ status: 'ready', ...catalog, error: null }),
      (error) => current && setState((state) => ({ ...state, status: 'error', error })),
    )
    return () => {
      current = false
    }
  }, [initialCatalog, userId, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const value = useMemo(() => ({ ...state, reload }), [state, reload])
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}

export function useCatalog() {
  return useContext(CatalogContext)
}
