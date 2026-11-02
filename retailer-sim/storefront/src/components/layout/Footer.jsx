import { getRequestContext } from '../../api/requestContext.js'

const year = new Date().getFullYear()

export function Footer() {
  const storeName = getRequestContext().tenantName || 'Basketline'
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p className="site-footer__brand">{storeName}</p>
        <p>© {year} {storeName}. All rights reserved.</p>
        <p className="site-footer__disclaimer">
          Disclaimer: product information, prices and campaigns shown on this site are sample data for demonstration
          only. No real orders can be placed.
        </p>
      </div>
    </footer>
  )
}
