import { memo, useId } from 'react'
import { Link } from 'react-router-dom'
import { useAnalytics } from '../../components/common/AnalyticsWrapper.jsx'
import { Button } from '../../components/common/Button.jsx'
import { EVENT_NAMES } from '../../analytics/eventSchema.js'
import { formatINR } from '../../utils/format.js'
import { QuantityStepper } from '../cart/QuantityStepper.jsx'
import { ProductImage } from './ProductImage.jsx'

/**
 * Presentational product card. It owns no cart state: it receives the
 * product's cart `quantity` and calls `onAddToCart` / `onDecrement`, and it
 * reports analytics for its own controls. The whole card links to the product's
 * page (product_click; an ad click on a campaign card). Without `onAddToCart`
 * (campaign cards) it has no cart controls: those products are added from their
 * page. Otherwise the controls sit above the link, so one click is never counted
 * as both a product click and a cart change.
 */
export const ProductCard = memo(function ProductCard({ product, quantity = 0, onAddToCart, onDecrement, position }) {
  const { track } = useAnalytics()
  const nameId = useId()

  const handleOpen = () => track(EVENT_NAMES.PRODUCT_CLICK, { productId: product.id, position, action: 'view_details' })

  return (
    <article className="product-card" aria-labelledby={nameId}>
      <ProductImage src={product.image} alt={product.name} />
      <div className="product-card__body">
        <p className="product-card__category">{product.category}</p>
        <h3 className="product-card__name" id={nameId}>
          <Link className="product-card__link" to={`/store/products/${product.id}`} onClick={handleOpen}>
            {product.name}
          </Link>
        </h3>
        <p className="product-card__price">{formatINR(product.price)}</p>
        {onAddToCart ? (
          <div className="product-card__actions">
            <ProductCartControls product={product} quantity={quantity} onAddToCart={onAddToCart} onDecrement={onDecrement} position={position} />
          </div>
        ) : null}
      </div>
    </article>
  )
})

/**
 * Add to cart, which becomes a "+N added" stepper once the product is in the
 * cart (back to Add to cart at 0), with the matching cart analytics.
 */
export function ProductCartControls({ product, quantity, onAddToCart, onDecrement, position }) {
  const { track } = useAnalytics()

  const handleAdd = () => {
    onAddToCart(product)
    track(EVENT_NAMES.ADD_TO_CART, { productId: product.id, quantity: 1, unitPrice: product.price, position })
  }

  const handleDecrement = () => {
    onDecrement?.(product)
    if (quantity <= 1) {
      track(EVENT_NAMES.REMOVE_FROM_CART, { productId: product.id, quantity, position })
    } else {
      track(EVENT_NAMES.CART_QUANTITY_UPDATE, { productId: product.id, previousQuantity: quantity, quantity: quantity - 1, position })
    }
  }

  return quantity > 0 && onDecrement ? (
    <QuantityStepper
      size="sm"
      productName={product.name}
      quantity={quantity}
      label={`+${quantity} added`}
      onIncrement={handleAdd}
      onDecrement={handleDecrement}
    />
  ) : (
    <Button onClick={handleAdd} aria-label={`Add ${product.name} to cart`}>
      Add to cart
    </Button>
  )
}
