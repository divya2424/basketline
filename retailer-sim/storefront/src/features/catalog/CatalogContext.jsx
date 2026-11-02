import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { fetchCatalog } from './catalogService.js'
import { sharedRequest } from '../../api/sharedRequest.js'

const EMPTY = { status: 'ready', products: [], campaigns: [], productsById: new Map(), error: null, reload: () => {} }
const CatalogContext = createContext(EMPTY)

/**
 * Loads the product catalog and active campaigns once for the whole app.
 * `initialCatalog` ({ products, campaigns }) skips the request (tests, previews).
 */
export function CatalogProvider({ children, initialCatalog }) {
  const [state, setState] = useState(() =>
    initialCatalog ? { status: 'ready', ...initialCatalog, error: null } : { status: 'loading', products: [], campaigns: [], error: null },
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (initialCatalog) return undefined
    let current = true
    setState((state) => ({ ...state, status: 'loading', error: null }))
    // Shared rather than aborted on cleanup, so StrictMode's dev re-mount doesn't cancel and resend it.
    sharedRequest(fetchCatalog, attempt, () => fetchCatalog()).then(
      (catalog) => current && setState({ status: 'ready', ...catalog, error: null }),
      (error) => current && setState((state) => ({ ...state, status: 'error', error })),
    )
    return () => {
      current = false
    }
  }, [initialCatalog, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const value = useMemo(
    () => ({ ...state, productsById: new Map(state.products.map((product) => [product.id, product])), reload }),
    [state, reload],
  )
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}

export function useCatalog() {
  return useContext(CatalogContext)
}
