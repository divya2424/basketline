import { Link } from 'react-router-dom'
import { AnalyticsWrapper, useAnalytics } from '../../components/common/AnalyticsWrapper.jsx'
import { Button } from '../../components/common/Button.jsx'
import { EVENT_NAMES } from '../../analytics/eventSchema.js'
import { useTrackOnMount } from '../../analytics/useTrackOnMount.js'
import { ProductImage } from '../products/ProductImage.jsx'
import { formatINR } from '../../utils/format.js'
import { useCart, useCartActions } from './CartContext.jsx'
import { QuantityStepper } from './QuantityStepper.jsx'

export function CartPage() {
  return (
    <AnalyticsWrapper featureName="cart" pageName="cart">
      <CartContent />
    </AnalyticsWrapper>
  )
}

function CartContent() {
  const { items, totalQuantity, subtotal } = useCart()
  useTrackOnMount(EVENT_NAMES.CART_VIEW, { lineCount: items.length, totalQuantity, subtotal })

  return (
    <div className="container page cart-page">
      <h1>Your cart</h1>
      {items.length === 0 ? (
        <div className="empty-state">
          <p>Your cart is empty.</p>
          <Link className="btn btn--primary" to="/store">
            Continue shopping
          </Link>
        </div>
      ) : (
        <div className="cart-layout">
          <ul className="cart-lines" aria-label="Cart items">
            {items.map((line) => (
              <CartLine key={line.productId} line={line} />
            ))}
          </ul>
          <aside className="cart-summary" aria-labelledby="summary-title">
            <h2 id="summary-title">Order summary</h2>
            <dl>
              <div>
                <dt>Items</dt>
                <dd data-testid="cart-total-quantity">{totalQuantity}</dd>
              </div>
              <div className="cart-summary__subtotal">
                <dt>Subtotal</dt>
                <dd data-testid="cart-subtotal">{formatINR(subtotal)}</dd>
              </div>
            </dl>
            <p className="muted small">Taxes and shipping are not calculated. Checkout is not available in this demo.</p>
            <Link to="/store" className="btn btn--secondary">
              Continue shopping
            </Link>
          </aside>
        </div>
      )}
    </div>
  )
}

const trashIcon = (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
)

function CartLine({ line }) {
  const { addItem, decrementItem, removeItem } = useCartActions()
  const { track } = useAnalytics()
  const { product, quantity, lineTotal } = line

  const increase = () => {
    addItem(product.id)
    track(EVENT_NAMES.CART_QUANTITY_UPDATE, { productId: product.id, previousQuantity: quantity, quantity: quantity + 1 })
  }

  // At quantity 1 the minus button removes the line.
  const decrease = () => {
    decrementItem(product.id)
    if (quantity <= 1) track(EVENT_NAMES.REMOVE_FROM_CART, { productId: product.id, quantity })
    else track(EVENT_NAMES.CART_QUANTITY_UPDATE, { productId: product.id, previousQuantity: quantity, quantity: quantity - 1 })
  }

  const remove = () => {
    removeItem(product.id)
    track(EVENT_NAMES.REMOVE_FROM_CART, { productId: product.id, quantity })
  }

  return (
    <li className="cart-line" data-testid={`cart-line-${product.id}`}>
      <ProductImage src={product.image} alt={product.name} className="cart-line__image" />
      <div className="cart-line__info">
        <h2 className="cart-line__name">{product.name}</h2>
        <p className="muted">
          Unit price: <span data-testid="unit-price">{formatINR(product.price)}</span>
        </p>
        <Button variant="danger" size="sm" onClick={remove} aria-label={`Remove all ${product.name} from cart`}>
          {trashIcon}
          Remove
        </Button>
      </div>
      <QuantityStepper productName={product.name} quantity={quantity} onIncrement={increase} onDecrement={decrease} />
      <p className="cart-line__total" data-testid="line-total">
        {formatINR(lineTotal)}
      </p>
    </li>
  )
}
