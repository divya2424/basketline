import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { products, productsById } from './productData.js'
import { ProductCard } from './ProductCard.jsx'
import { AnalyticsWrapper } from '../../components/common/AnalyticsWrapper.jsx'
import { renderApp, eventsNamed } from '../../test/utils.jsx'
import { localCollector } from '../../analytics/analytics.js'

describe('product data', () => {
  it('has exactly 10 products with unique, stable IDs', () => {
    expect(products).toHaveLength(10)
    expect(new Set(products.map((p) => p.id)).size).toBe(10)
    expect(productsById.size).toBe(10)
  })

  it('gives every product the required fields and a numeric price', () => {
    for (const product of products) {
      for (const field of ['id', 'name', 'description', 'image', 'category']) {
        expect(typeof product[field], `${product.id}.${field}`).toBe('string')
        expect(product[field].length).toBeGreaterThan(0)
      }
      expect(Number.isFinite(product.price)).toBe(true)
      expect(product.price).toBeGreaterThan(0)
    }
  })
})

describe('catalog', () => {
  it('renders all 10 products on the home page with image, name, price and button', () => {
    renderApp('/store')
    const catalog = screen.getByRole('region', { name: 'All products' })
    const cards = catalog.querySelectorAll('article.product-card')
    expect(cards).toHaveLength(10)
    for (const product of products) {
      expect(catalog).toHaveTextContent(product.name)
      expect(screen.getAllByRole('button', { name: `Add ${product.name} to cart` }).length).toBeGreaterThan(0)
    }
    expect(catalog).toHaveTextContent('₹2,999')
  })
})

describe('ProductCard', () => {
  const product = products[0]
  // The card links to the product's page, so it needs a router.
  const render = (ui) => renderInRouter(ui)

  it('shows a fallback when the image is missing', () => {
    render(<ProductCard product={{ ...product, image: '' }} onAddToCart={() => {}} />)
    expect(screen.getByRole('img', { name: /image unavailable/i })).toBeInTheDocument()
  })

  it('shows a fallback when the image fails to load', () => {
    render(<ProductCard product={product} onAddToCart={() => {}} />)
    fireEvent.error(screen.getByRole('img', { name: product.name }))
    expect(screen.getByRole('img', { name: /image unavailable/i })).toBeInTheDocument()
  })

  it('calls the provided cart action and tracks only add_to_cart (no bubbled product_click)', async () => {
    const onAddToCart = vi.fn()
    render(
      <AnalyticsWrapper featureName="product_card" pageName="home" properties={{ source: 'catalog_grid' }}>
        <ProductCard product={product} onAddToCart={onAddToCart} position={1} />
      </AnalyticsWrapper>,
    )
    await userEvent.click(screen.getByRole('button', { name: `Add ${product.name} to cart` }))

    expect(onAddToCart).toHaveBeenCalledWith(product)
    const events = localCollector.getEvents()
    expect(events.map((e) => e.eventName)).toEqual(['add_to_cart'])
    expect(events[0]).toMatchObject({
      featureName: 'product_card',
      pageName: 'home',
      properties: { productId: product.id, quantity: 1, source: 'catalog_grid', position: 1 },
    })
  })

  it('links the card to the product page and tracks product_click, independently of add to cart', async () => {
    render(<ProductCard product={product} onAddToCart={() => {}} position={2} />)
    const link = screen.getByRole('link', { name: product.name })
    expect(link).toHaveAttribute('href', `/store/products/${product.id}`)
    await userEvent.click(link)
    expect(localCollector.getEvents()).toMatchObject([
      { eventName: 'product_click', properties: { productId: product.id, position: 2, action: 'view_details' } },
    ])
  })

  it('is keyboard operable', async () => {
    const onAddToCart = vi.fn()
    render(<ProductCard product={product} onAddToCart={onAddToCart} />)
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: `Add ${product.name} to cart` })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onAddToCart).toHaveBeenCalledTimes(1)
  })
})

describe('product card cart controls', () => {
  const catalogCard = (name) => within(screen.getByRole('region', { name: 'All products' })).getByRole('article', { name })

  it('turns Add to cart into a "+N added" stepper, and back to Add to cart at 0', async () => {
    const user = userEvent.setup()
    renderApp('/store')
    const card = () => catalogCard('Pulse Bluetooth Speaker')

    await user.click(within(card()).getByRole('button', { name: 'Add Pulse Bluetooth Speaker to cart' }))
    expect(within(card()).getByTestId('quantity')).toHaveTextContent('+1 added')
    expect(within(card()).queryByRole('button', { name: /^Add .* to cart$/ })).not.toBeInTheDocument()

    await user.click(within(card()).getByRole('button', { name: 'Increase quantity of Pulse Bluetooth Speaker' }))
    expect(within(card()).getByTestId('quantity')).toHaveTextContent('+2 added')
    expect(screen.getByTestId('cart-badge')).toHaveTextContent('2')

    await user.click(within(card()).getByRole('button', { name: 'Decrease quantity of Pulse Bluetooth Speaker' }))
    expect(within(card()).getByTestId('quantity')).toHaveTextContent('+1 added')

    await user.click(within(card()).getByRole('button', { name: 'Remove Pulse Bluetooth Speaker from cart' }))
    expect(within(card()).getByRole('button', { name: 'Add Pulse Bluetooth Speaker to cart' })).toBeInTheDocument()
    expect(screen.getByTestId('cart-badge')).toHaveTextContent('0')

    expect(localCollector.getEvents().map((e) => e.eventName).filter((n) => n !== 'home_view' && n !== 'campaign_impression')).toEqual([
      'add_to_cart',
      'add_to_cart',
      'cart_quantity_update',
      'remove_from_cart',
    ])
  })
})

describe('home page analytics', () => {
  it('emits exactly one home_view per visit, even under StrictMode', () => {
    renderApp('/store')
    expect(eventsNamed('home_view')).toHaveLength(1)
  })
})

function renderInRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('product page', () => {
  it('opens from a card with the full details, and adds to the cart from there', async () => {
    const user = userEvent.setup()
    renderApp('/store')
    const product = products[3]
    const grid = screen.getByRole('region', { name: 'All products' })
    await user.click(within(grid).getByRole('link', { name: product.name }))

    expect(await screen.findByRole('heading', { level: 1, name: product.name })).toBeInTheDocument()
    expect(screen.getByText(product.description)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `Add ${product.name} to cart` }))
    expect(screen.getByTestId('cart-badge')).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: `Remove ${product.name} from cart` })).toBeInTheDocument()
    expect(eventsNamed('add_to_cart')).toMatchObject([{ featureName: 'product_detail', pageName: 'product', properties: { productId: product.id } }])

    await user.click(screen.getByRole('link', { name: '← Back to the store' }))
    expect(screen.getByRole('region', { name: 'All products' })).toBeInTheDocument()
  })

  it('says so when the product is not in the catalog', async () => {
    renderApp('/store/products/missing')
    expect(await screen.findByRole('heading', { name: 'Product not found' })).toBeInTheDocument()
  })
})
