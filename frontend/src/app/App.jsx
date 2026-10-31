import { lazy, Suspense } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { Header } from '../components/layout/Header.jsx'
import { Footer } from '../components/layout/Footer.jsx'
import { ToastProvider } from '../components/common/Toast.jsx'
import { CartProvider } from '../features/cart/CartContext.jsx'
import { HomePage } from '../pages/HomePage.jsx'
import { Spinner } from '../components/common/Spinner.jsx'
import { AuthProvider } from '../features/auth/AuthContext.jsx'
import { RequireRole } from '../features/auth/RequireRole.jsx'
import { RequireTenant } from '../features/auth/RequireTenant.jsx'
import { ROLES } from '../features/auth/authService.js'
import { CatalogProvider } from '../features/catalog/CatalogContext.jsx'
import { OnboardingPage } from '../features/onboarding/OnboardingPage.jsx'

// The product page, cart and dashboard aren't needed for the first paint of the storefront.
const CartPage = lazy(() => import('../features/cart/CartPage.jsx').then((m) => ({ default: m.CartPage })))
const ProductDetailPage = lazy(() => import('../features/products/ProductDetailPage.jsx').then((m) => ({ default: m.ProductDetailPage })))
const AnalyticsPage = lazy(() => import('../features/analytics/AnalyticsPage.jsx').then((m) => ({ default: m.AnalyticsPage })))

const pageFallback = (
  <div className="container page page-loading" role="status">
    <Spinner size="lg" />
    <p className="muted">Loading page…</p>
  </div>
)

export function App({ cartProps, authProps, catalogProps, onboardingProps }) {
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
                  {/* The platform starts at onboarding; a tenant's store opens after signing in to it. */}
                  <Route path="/" element={<OnboardingPage {...onboardingProps} />} />
                  <Route path="/onboarding" element={<Navigate to="/" replace />} />
                  <Route path="/store" element={<RequireTenant><HomePage /></RequireTenant>} />
                  <Route path="/store/products/:productId" element={<RequireTenant><ProductDetailPage /></RequireTenant>} />
                  <Route path="/cart" element={<RequireTenant><CartPage /></RequireTenant>} />
                  <Route
                    path="/analytics"
                    element={
                      <RequireTenant>
                        <RequireRole role={[ROLES.CAMPAIGN_MANAGER, ROLES.SELLER_MANAGER]} pageName="analytics">
                          <AnalyticsPage />
                        </RequireRole>
                      </RequireTenant>
                    }
                  />
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
