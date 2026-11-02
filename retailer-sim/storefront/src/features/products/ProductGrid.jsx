import { ProductCard } from './ProductCard.jsx'

export function ProductGrid({ products, quantities, onAddToCart, onDecrement }) {
  return (
    <ul className="product-grid">
      {products.map((product, index) => (
        <li key={product.id}>
          <ProductCard
            product={product}
            quantity={quantities?.get(product.id) ?? 0}
            onAddToCart={onAddToCart}
            onDecrement={onDecrement}
            position={index + 1}
          />
        </li>
      ))}
    </ul>
  )
}
