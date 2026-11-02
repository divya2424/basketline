import { useCallback } from 'react'
import { useCartActions } from './CartContext.jsx'
import { useToast } from '../../components/common/Toast.jsx'

/** Stable callback that adds one unit of a product and confirms it to the user. */
export function useAddToCart() {
  const { addItem } = useCartActions()
  const showToast = useToast()
  return useCallback(
    (product) => {
      addItem(product.id)
      showToast(`Added ${product.name} to your cart`)
    },
    [addItem, showToast],
  )
}

/** Stable callback that removes one unit; the line disappears at 0. */
export function useDecrementFromCart() {
  const { decrementItem } = useCartActions()
  return useCallback((product) => decrementItem(product.id), [decrementItem])
}
