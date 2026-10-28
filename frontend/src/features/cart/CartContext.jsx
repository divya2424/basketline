import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import { addLine, decrementLine, getSubtotal, getTotalQuantity, removeLine, resolveCartLines, setLineQuantity } from './cartUtils.js'
import { loadCart, saveCart } from './cartStorage.js'

// State and actions live in separate contexts: components that only add items
// (product cards) subscribe to the stable actions and don't re-render when the
// cart contents change.
const CartStateContext = createContext(null)
const CartActionsContext = createContext(null)

export function CartProvider({ children, initialLines, persist = true }) {
  // Product details (name, price, image) come from the catalog loaded from the API.
  const { productsById: catalog } = useCatalog()
  const [lines, setLines] = useState(() => initialLines ?? (persist ? loadCart() : []))

  useEffect(() => {
    if (persist) saveCart(lines)
  }, [lines, persist])

  const actions = useMemo(
    () => ({
      addItem: (productId, quantity = 1) => setLines((current) => addLine(current, productId, quantity)),
      updateQuantity: (productId, quantity) => setLines((current) => setLineQuantity(current, productId, quantity)),
      decrementItem: (productId) => setLines((current) => decrementLine(current, productId)),
      removeItem: (productId) => setLines((current) => removeLine(current, productId)),
      clear: () => setLines([]),
    }),
    [],
  )

  const state = useMemo(() => {
    const items = resolveCartLines(lines, catalog)
    // Per-product quantities let product cards receive a primitive prop, so
    // memoized cards only re-render when their own quantity changes.
    const quantities = new Map(items.map((line) => [line.productId, line.quantity]))
    return { items, quantities, totalQuantity: getTotalQuantity(items), subtotal: getSubtotal(items) }
  }, [lines, catalog])

  return (
    <CartActionsContext.Provider value={actions}>
      <CartStateContext.Provider value={state}>{children}</CartStateContext.Provider>
    </CartActionsContext.Provider>
  )
}

export function useCart() {
  const state = useContext(CartStateContext)
  if (!state) throw new Error('useCart must be used inside <CartProvider>')
  return state
}

export function useCartActions() {
  const actions = useContext(CartActionsContext)
  if (!actions) throw new Error('useCartActions must be used inside <CartProvider>')
  return actions
}
