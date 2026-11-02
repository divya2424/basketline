import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../features/auth/AuthContext.jsx'
import { ROLES } from '../../features/auth/authService.js'
import { getRequestContext } from '../../api/requestContext.js'
import { Button } from '../common/Button.jsx'

const navClass = ({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')

/**
 * Two modes. On the onboarding page (/) it shows only the platform's brand.
 * Inside a tenant (signed in, any other page) the brand is the tenant's name,
 * with Analytics, the user and Logout (back to onboarding). There is no Login
 * button: signing in happens from the onboarding page.
 */
export function Header() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const inTenant = Boolean(user) && pathname !== '/'

  if (!inTenant) {
    return (
      <header className="site-header">
        <div className="container site-header__inner">
          <Link to="/" className="brand" aria-label="Basketline: onboarding">
            <span className="brand__mark" aria-hidden="true" />
            Basketline
          </Link>
        </div>
      </header>
    )
  }

  const tenantName = getRequestContext().tenantName || 'Basketline'
  const seesAnalytics = user.role === ROLES.CAMPAIGN_MANAGER
  const signOut = async () => {
    await logout()
    navigate('/')
  }

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link to="/analytics" className="brand" aria-label={`${tenantName} analytics`}>
          <span className="brand__mark" aria-hidden="true" />
          {tenantName}
        </Link>
        <nav className="site-nav" aria-label="Main">
          {seesAnalytics ? (
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
        </div>
      </div>
    </header>
  )
}
