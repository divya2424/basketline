import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useCart } from '../../features/cart/CartContext.jsx'
import { useAuth } from '../../features/auth/AuthContext.jsx'
import { LoginModal } from '../../features/auth/LoginModal.jsx'
import { getRequestContext } from '../../api/requestContext.js'
import { trackEvent } from '../../analytics/analytics.js'
import { EVENT_NAMES } from '../../analytics/eventSchema.js'
import { Button } from '../common/Button.jsx'

const cartIcon = (
  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="20" r="1.5" />
    <circle cx="18" cy="20" r="1.5" />
    <path d="M2.5 3h2.6l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.1L21.5 8H6.1" />
  </svg>
)

const navClass = ({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')

/** The store's name, Home, the seller portal (for sellers) and Stores, the signed-in user and Logout (or Log in for visitors), and the cart. */
export function Header() {
  const { totalQuantity } = useCart()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [loginOpen, setLoginOpen] = useState(false)

  const tenantName = getRequestContext().tenantName || 'Basketline'
  const cartLabel = `Cart, ${totalQuantity} ${totalQuantity === 1 ? 'item' : 'items'}`
  const openLogin = () => {
    setLoginOpen(true)
    trackEvent({ featureName: 'header', pageName: 'store', eventName: EVENT_NAMES.LOGIN_CLICK, properties: {} })
  }
  const signOut = async () => {
    await logout()
    navigate('/store')
  }

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link to="/store" className="brand" aria-label={`${tenantName} home`}>
          <span className="brand__mark" aria-hidden="true" />
          {tenantName}
        </Link>
        <nav className="site-nav" aria-label="Main">
          <NavLink to="/store" end className={navClass}>
            Home
          </NavLink>
          {user?.role === 'seller' ? (
            <NavLink to="/seller" className={navClass}>
              Seller portal
            </NavLink>
          ) : null}
          <NavLink to="/stores" className={navClass}>
            Stores
          </NavLink>
        </nav>
        <div className="site-header__actions">
          {user ? (
            <>
              <span className="user-chip" title={user.displayName}>
                {user.displayName}
              </span>
              <Button variant="ghost" onClick={signOut}>
                Logout
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={openLogin}>
              Log in
            </Button>
          )}
          <NavLink to="/cart" className={({ isActive }) => `cart-link${isActive ? ' cart-link--active' : ''}`} aria-label={cartLabel}>
            {cartIcon}
            <span className="cart-badge" data-testid="cart-badge" aria-hidden="true">
              {totalQuantity}
            </span>
          </NavLink>
        </div>
      </div>
      {loginOpen ? <LoginModal title={`Sign in to ${tenantName}`} onClose={() => setLoginOpen(false)} /> : null}
    </header>
  )
}
