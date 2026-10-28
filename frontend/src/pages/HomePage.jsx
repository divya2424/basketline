import { AnalyticsWrapper } from '../components/common/AnalyticsWrapper.jsx'
import { Button } from '../components/common/Button.jsx'
import { Spinner } from '../components/common/Spinner.jsx'
import { EVENT_NAMES } from '../analytics/eventSchema.js'
import { useTrackOnMount } from '../analytics/useTrackOnMount.js'
import { CampaignCarousel } from '../features/campaigns/CampaignCarousel.jsx'
import { ProductGrid } from '../features/products/ProductGrid.jsx'
import { useAddToCart, useDecrementFromCart } from '../features/cart/useAddToCart.js'
import { useCart } from '../features/cart/CartContext.jsx'
import { useCatalog } from '../features/catalog/CatalogContext.jsx'

export function HomePage() {
  const catalog = useCatalog()
  return (
    <AnalyticsWrapper featureName="home" pageName="home">
      <div className="container page">
        <h1 className="visually-hidden">ShopSphere storefront</h1>
        {catalog.status === 'loading' ? (
          <div className="page-loading" role="status">
            <Spinner size="lg" />
            <p className="muted">Loading products…</p>
          </div>
        ) : catalog.status === 'error' ? (
          <div className="empty-state" role="alert">
            <p>We couldn’t load the store right now. {catalog.error?.message}</p>
            <Button onClick={catalog.reload}>Try again</Button>
          </div>
        ) : catalog.products.length === 0 ? (
          <div className="empty-state">
            <p>No products yet.</p>
          </div>
        ) : (
          <Storefront products={catalog.products} productsById={catalog.productsById} campaigns={catalog.campaigns} />
        )}
      </div>
    </AnalyticsWrapper>
  )
}

/** Rendered once the catalog has loaded, so home_view carries the real counts. */
function Storefront({ products, productsById, campaigns }) {
  const handleAddToCart = useAddToCart()
  const handleDecrement = useDecrementFromCart()
  const { quantities } = useCart()
  useTrackOnMount(EVENT_NAMES.HOME_VIEW, { productCount: products.length, campaignCount: campaigns.length })

  return (
    <>
      <CampaignCarousel campaigns={campaigns} productsById={productsById} />

      <section className="catalog" aria-labelledby="catalog-title">
        <div className="section-heading">
          <h2 id="catalog-title">All products</h2>
          <p className="muted">{products.length} items</p>
        </div>
        <AnalyticsWrapper featureName="product_card" properties={{ source: 'catalog_grid' }}>
          <ProductGrid products={products} quantities={quantities} onAddToCart={handleAddToCart} onDecrement={handleDecrement} />
        </AnalyticsWrapper>
      </section>
    </>
  )
}
