import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addLine, decrementLine, getSubtotal, getTotalQuantity, removeLine, resolveCartLines, setLineQuantity } from './cartUtils.js'
import { productsById } from '../products/productData.js'
import { renderApp, eventsNamed, MANAGER } from '../../test/utils.jsx'
import { setTransport } from '../../analytics/analytics.js'

describe('cartUtils', () => {
  it('creates a line with quantity 1, then increments instead of duplicating', () => {
    let lines = addLine([], 'product_001')
    expect(lines).toEqual([{ productId: 'product_001', quantity: 1 }])
    lines = addLine(lines, 'product_001')
    expect(lines).toEqual([{ productId: 'product_001', quantity: 2 }])
  })

  it('computes line totals, subtotal and total quantity', () => {
    const lines = [
      { productId: 'product_001', quantity: 2 }, // 2999 × 2
      { productId: 'product_009', quantity: 3 }, // 899 × 3
    ]
    const resolved = resolveCartLines(lines, productsById)
    expect(resolved.map((l) => l.lineTotal)).toEqual([5998, 2697])
    expect(getSubtotal(resolved)).toBe(8695)
    expect(getTotalQuantity(lines)).toBe(5)
  })

  it('rejects quantities below 1 and removes lines', () => {
    const lines = [{ productId: 'product_001', quantity: 2 }]
    expect(setLineQuantity(lines, 'product_001', 0)).toBe(lines)
    expect(setLineQuantity(lines, 'product_001', 4)).toEqual([{ productId: 'product_001', quantity: 4 }])
    expect(removeLine(lines, 'product_001')).toEqual([])
  })

  it('decrements a line and removes it when it reaches 0', () => {
    const lines = [{ productId: 'product_001', quantity: 2 }]
    const once = decrementLine(lines, 'product_001')
    expect(once).toEqual([{ productId: 'product_001', quantity: 1 }])
    expect(decrementLine(once, 'product_001')).toEqual([])
  })

  it('drops lines for products that no longer exist', () => {
    expect(resolveCartLines([{ productId: 'gone', quantity: 1 }], productsById)).toEqual([])
  })
})

const badge = () => screen.getByTestId('cart-badge')
const catalog = () => screen.getByRole('region', { name: 'All products' })

// The first click uses Add to cart; after that the card shows a stepper.
async function addFromCatalog(user, name, times = 1) {
  for (let i = 0; i < times; i += 1) {
    const add = within(catalog()).queryByRole('button', { name: `Add ${name} to cart` })
    await user.click(add ?? within(catalog()).getByRole('button', { name: `Increase quantity of ${name}` }))
  }
}

describe('shopping cart flow', () => {
  it('updates the header badge with total quantity and shows feedback', async () => {
    const user = userEvent.setup()
    renderApp('/store')
    expect(badge()).toHaveTextContent('0')
    await addFromCatalog(user, 'Aurora Wireless Earbuds', 2)
    await addFromCatalog(user, 'Verde Insulated Steel Bottle')
    expect(badge()).toHaveTextContent('3')
    expect(screen.getByRole('link', { name: 'Cart, 3 items' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Added Verde Insulated Steel Bottle to your cart')
    expect(eventsNamed('add_to_cart')).toHaveLength(3)
  })

  it('shows lines, subtotal, and supports quantity changes and removal on /cart', async () => {
    const user = userEvent.setup()
    renderApp('/store')
    await addFromCatalog(user, 'Aurora Wireless Earbuds', 2)
    await addFromCatalog(user, 'Verde Insulated Steel Bottle')

    await user.click(screen.getByRole('link', { name: /^Cart,/ }))
    expect(await screen.findByRole('heading', { name: 'Your cart' })).toBeInTheDocument()
    expect(eventsNamed('cart_view')).toHaveLength(1)

    const earbuds = screen.getByTestId('cart-line-product_001')
    expect(within(earbuds).getByTestId('quantity')).toHaveTextContent('2')
    expect(within(earbuds).getByTestId('line-total')).toHaveTextContent('₹5,998')
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹6,897')

    await user.click(screen.getByRole('button', { name: 'Increase quantity of Aurora Wireless Earbuds' }))
    expect(within(earbuds).getByTestId('quantity')).toHaveTextContent('3')
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹9,896')
    expect(badge()).toHaveTextContent('4')

    // At quantity 1 the minus button becomes a remove button.
    const bottle = screen.getByTestId('cart-line-product_009')
    expect(within(bottle).getByTestId('quantity')).toHaveTextContent('1')
    await user.click(within(bottle).getByRole('button', { name: 'Remove Verde Insulated Steel Bottle from cart' }))
    expect(screen.queryByTestId('cart-line-product_009')).not.toBeInTheDocument()
    expect(badge()).toHaveTextContent('3')

    expect(eventsNamed('cart_quantity_update')[0].properties).toMatchObject({
      productId: 'product_001',
      previousQuantity: 2,
      quantity: 3,
    })
    expect(eventsNamed('remove_from_cart')[0].properties).toMatchObject({ productId: 'product_009', quantity: 1 })
  })

  it('keeps the cart when navigating between routes', async () => {
    const user = userEvent.setup()
    renderApp('/store', { authProps: { persist: false, initialUser: MANAGER } })
    await addFromCatalog(user, 'Nimbus Smartwatch')
    await user.click(screen.getByRole('link', { name: 'Analytics' }))
    await screen.findByRole('heading', { name: 'Campaign Analytics' })
    await user.click(screen.getByRole('link', { name: 'Home' }))
    expect(badge()).toHaveTextContent('1')
  })

  it('removes a whole line with the Remove button, whatever the quantity', async () => {
    const user = userEvent.setup()
    renderApp('/store')
    await addFromCatalog(user, 'Nimbus Smartwatch', 3)
    await user.click(screen.getByRole('link', { name: /^Cart,/ }))
    await user.click(await screen.findByRole('button', { name: 'Remove all Nimbus Smartwatch from cart' }))
    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument()
    expect(badge()).toHaveTextContent('0')
    expect(eventsNamed('remove_from_cart').at(-1).properties).toMatchObject({ productId: 'product_002', quantity: 3 })
  })

  it('decreases quantity one step at a time on the cart page', async () => {
    const user = userEvent.setup()
    renderApp('/store')
    await addFromCatalog(user, 'Nimbus Smartwatch', 2)
    await user.click(screen.getByRole('link', { name: /^Cart,/ }))
    await user.click(await screen.findByRole('button', { name: 'Decrease quantity of Nimbus Smartwatch' }))
    expect(screen.getByTestId('quantity')).toHaveTextContent('1')
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹5,499')
    await user.click(screen.getByRole('button', { name: 'Remove Nimbus Smartwatch from cart' }))
    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument()
  })

  it('shows an empty state with a link to continue shopping', async () => {
    renderApp('/cart')
    expect(await screen.findByText('Your cart is empty.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Continue shopping' })).toHaveAttribute('href', '/store')
  })

  it('still adds to the cart when analytics delivery throws', async () => {
    setTransport({
      send() {
        throw new Error('collector down')
      },
    })
    const user = userEvent.setup()
    renderApp('/store')
    await addFromCatalog(user, 'Nimbus Smartwatch')
    expect(badge()).toHaveTextContent('1')
  })

  it('persists the cart to localStorage when enabled', async () => {
    const user = userEvent.setup()
    const { unmount } = renderApp('/store', { cartProps: {} })
    await addFromCatalog(user, 'Nimbus Smartwatch')
    unmount()
    renderApp('/store', { cartProps: {} })
    expect(badge()).toHaveTextContent('1')
  })
})

describe('layout', () => {
  it.each(['/store', '/cart', '/analytics'])('renders the header and footer on %s', async (route) => {
    renderApp(route)
    expect(await screen.findByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/sample data/i)
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/store')
  })
})
