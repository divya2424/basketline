import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AnalyticsWrapper } from '../../components/common/AnalyticsWrapper.jsx'
import { Button } from '../../components/common/Button.jsx'
import { Spinner } from '../../components/common/Spinner.jsx'
import { formatINR } from '../../utils/format.js'
import { useCart } from '../cart/CartContext.jsx'
import { useAddToCart, useDecrementFromCart } from '../cart/useAddToCart.js'
import { useCatalog } from '../catalog/CatalogContext.jsx'
import { ProductCartControls } from './ProductCard.jsx'
import { ProductImage } from './ProductImage.jsx'

/** One product of the current tenant's catalog, opened from its card. */
export function ProductDetailPage() {
  const { productId } = useParams()
  const catalog = useCatalog()
  const { quantities } = useCart()
  const handleAddToCart = useAddToCart()
  const handleDecrement = useDecrementFromCart()
  const product = catalog.productsById.get(productId)

  // Cards are opened from anywhere down the store page.
  // A block body: newer browsers return a Promise from scrollTo, which React would take for a cleanup.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [productId])

  return (
    <AnalyticsWrapper featureName="product_detail" pageName="product">
      <div className="container page">
        <Link className="product-detail__back" to="/store">
          ← Back to the store
        </Link>
        {catalog.status === 'loading' ? (
          <div className="page-loading" role="status">
            <Spinner size="lg" />
            <p className="muted">Loading product…</p>
          </div>
        ) : catalog.status === 'error' ? (
          <div className="empty-state" role="alert">
            <p>We couldn’t load this product right now. {catalog.error?.message}</p>
            <Button onClick={catalog.reload}>Try again</Button>
          </div>
        ) : !product ? (
          <div className="empty-state">
            <h1>Product not found</h1>
          </div>
        ) : (
          <article className="product-detail" aria-labelledby="product-detail-name">
            <ProductImage src={product.image} alt={product.name} />
            <div className="product-detail__body">
              <p className="product-card__category">{product.category}</p>
              <h1 id="product-detail-name">{product.name}</h1>
              <p className="product-detail__price">{formatINR(product.price)}</p>
              <p className="product-detail__description">{product.description}</p>
              <ProductCartControls
                product={product}
                quantity={quantities.get(product.id) ?? 0}
                onAddToCart={handleAddToCart}
                onDecrement={handleDecrement}
              />
            </div>
          </article>
        )}
      </div>
    </AnalyticsWrapper>
  )
}
