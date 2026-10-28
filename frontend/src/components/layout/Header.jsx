import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useCart } from '../../features/cart/CartContext.jsx'
import { useAuth } from '../../features/auth/AuthContext.jsx'
import { ROLES } from '../../features/auth/authService.js'
import { getRequestContext } from '../../api/requestContext.js'
import { Button } from '../common/Button.jsx'

const cartIcon = (
  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="20" r="1.5" />
    <circle cx="18" cy="20" r="1.5" />
    <path d="M2.5 3h2.6l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.1L21.5 8H6.1" />
  </svg>
)

const navClass = ({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')

/**
 * Two modes. On the onboarding page (/) it shows only the platform's brand.
 * Inside a tenant (signed in, any other page) the brand is the tenant's name,
 * with the store's links, the user, Logout (back to onboarding) and the cart.
 * There is no Login button: signing in happens from the onboarding page.
 */
export function Header() {
  const { totalQuantity } = useCart()
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const inTenant = Boolean(user) && pathname !== '/'

  if (!inTenant) {
    return (
      <header className="site-header">
        <div className="container site-header__inner">
          <Link to="/" className="brand" aria-label="ShopSphere: onboarding">
            <span className="brand__mark" aria-hidden="true" />
            ShopSphere
          </Link>
        </div>
      </header>
    )
  }

  const tenantName = getRequestContext().tenantName || 'ShopSphere'
  const isCampaignManager = user.role === ROLES.CAMPAIGN_MANAGER
  const cartLabel = `Cart, ${totalQuantity} ${totalQuantity === 1 ? 'item' : 'items'}`
  const signOut = async () => {
    await logout()
    navigate('/')
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
          {isCampaignManager ? (
            <NavLink to="/analytics" className={navClass}>
              Analytics
            </NavLink>
          ) : null}
        </nav>
        <div className="site-header__actions">
          <span className="user-chip" title={user.displayName}>
            {user.displayName}
          </span>
          <Button variant="ghost" onClick={signOut}>
            Logout
          </Button>
          <NavLink to="/cart" className={({ isActive }) => `cart-link${isActive ? ' cart-link--active' : ''}`} aria-label={cartLabel}>
            {cartIcon}
            <span className="cart-badge" data-testid="cart-badge" aria-hidden="true">
              {totalQuantity}
            </span>
          </NavLink>
        </div>
      </div>
    </header>
  )
}
