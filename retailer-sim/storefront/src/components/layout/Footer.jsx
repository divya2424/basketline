const year = new Date().getFullYear()

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p className="site-footer__brand">Basketline</p>
        <p>© {year} Basketline. All rights reserved.</p>
        <p className="site-footer__disclaimer">
          Disclaimer: product information, prices and campaigns shown on this site are sample data for demonstration
          only. No real orders can be placed.
        </p>
      </div>
    </footer>
  )
}
