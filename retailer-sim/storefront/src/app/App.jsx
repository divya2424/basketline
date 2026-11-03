import { lazy, Suspense } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { Header } from '../components/layout/Header.jsx'
import { Footer } from '../components/layout/Footer.jsx'
import { ToastProvider } from '../components/common/Toast.jsx'
import { CartProvider } from '../features/cart/CartContext.jsx'
import { HomePage } from '../pages/HomePage.jsx'
import { Spinner } from '../components/common/Spinner.jsx'
import { AuthProvider } from '../features/auth/AuthContext.jsx'
import { CatalogProvider } from '../features/catalog/CatalogContext.jsx'
import { StoresPage } from '../features/stores/StoresPage.jsx'
import { MarketplacePage } from '../features/marketplace/MarketplacePage.jsx'

// The seller portal is for sellers only.
const SellerPortalPage = lazy(() => import('../features/seller/SellerPortalPage.jsx').then((m) => ({ default: m.SellerPortalPage })))
const CampaignAnalyticsPage = lazy(() => import('../features/seller/CampaignAnalyticsPage.jsx').then((m) => ({ default: m.CampaignAnalyticsPage })))

// The product page and cart aren't needed for the first paint of the store.
const CartPage = lazy(() => import('../features/cart/CartPage.jsx').then((m) => ({ default: m.CartPage })))
const ProductDetailPage = lazy(() => import('../features/products/ProductDetailPage.jsx').then((m) => ({ default: m.ProductDetailPage })))

const pageFallback = (
  <div className="container page page-loading" role="status">
    <Spinner size="lg" />
    <p className="muted">Loading page…</p>
  </div>
)

export function App({ cartProps, authProps, catalogProps, storesProps }) {
  return (
    <AuthProvider {...authProps}>
      <CatalogProvider {...catalogProps}>
        <ToastProvider>
          <CartProvider {...cartProps}>
            <a href="#main" className="skip-link">
              Skip to content
            </a>
            <Header />
            <main id="main" className="site-main">
              <Suspense fallback={pageFallback}>
                <Routes>
                  {/* The marketplaces; each one's page offers selling (as a seller) or shopping. */}
                  <Route path="/" element={<StoresPage {...storesProps} />} />
                  <Route path="/m/:tenantId" element={<MarketplacePage />} />
                  {/* Visitors browse and shop signed out; signing in is optional. */}
                  <Route path="/store" element={<HomePage />} />
                  <Route path="/store/products/:productId" element={<ProductDetailPage />} />
                  <Route path="/cart" element={<CartPage />} />
                  <Route path="/stores" element={<Navigate to="/" replace />} />
                  <Route path="/seller" element={<SellerPortalPage />} />
                  <Route path="/seller/campaigns/:campaignId" element={<CampaignAnalyticsPage />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </main>
            <Footer />
          </CartProvider>
        </ToastProvider>
      </CatalogProvider>
    </AuthProvider>
  )
}

function NotFound() {
  return (
    <div className="container page empty-state">
      <h1>Page not found</h1>
      <Link className="btn btn--primary" to="/store">
        Back to the store
      </Link>
    </div>
  )
}
