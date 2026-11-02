const trashIcon = (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
)

/**
 * − / value / + control. At quantity 1 the minus button removes the item, and
 * shows a bin icon so that's clear before it's pressed.
 */
export function QuantityStepper({ productName, quantity, label, onIncrement, onDecrement, size }) {
  const removes = quantity <= 1
  return (
    <div className={`quantity${size ? ` quantity--${size}` : ''}`} role="group" aria-label={`Quantity for ${productName}`}>
      <button
        type="button"
        className={`quantity__btn${removes ? ' quantity__btn--remove' : ''}`}
        onClick={onDecrement}
        aria-label={removes ? `Remove ${productName} from cart` : `Decrease quantity of ${productName}`}
      >
        {removes ? trashIcon : '−'}
      </button>
      <span className="quantity__value" aria-live="polite" data-testid="quantity">
        {label ?? quantity}
      </span>
      <button type="button" className="quantity__btn" onClick={onIncrement} aria-label={`Increase quantity of ${productName}`}>
        +
      </button>
    </div>
  )
}
