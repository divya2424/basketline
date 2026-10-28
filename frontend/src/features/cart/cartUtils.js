// Pure cart helpers. A cart is an array of { productId, quantity } lines;
// product details are looked up from the catalog so they never go stale.

export function addLine(lines, productId, quantity = 1) {
  const existing = lines.find((line) => line.productId === productId)
  if (!existing) return [...lines, { productId, quantity }]
  return lines.map((line) => (line.productId === productId ? { ...line, quantity: line.quantity + quantity } : line))
}

/** Quantities below 1 are rejected; use removeLine to delete a product. */
export function setLineQuantity(lines, productId, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) return lines
  return lines.map((line) => (line.productId === productId ? { ...line, quantity } : line))
}

/** Lowers a line's quantity by one, removing the line when it reaches 0. */
export function decrementLine(lines, productId) {
  return lines.flatMap((line) => {
    if (line.productId !== productId) return [line]
    return line.quantity > 1 ? [{ ...line, quantity: line.quantity - 1 }] : []
  })
}

export function removeLine(lines, productId) {
  return lines.filter((line) => line.productId !== productId)
}

export function getTotalQuantity(lines) {
  let total = 0
  for (const line of lines) total += line.quantity
  return total
}

/** Joins lines with catalog data; lines whose product no longer exists are dropped. */
export function resolveCartLines(lines, productsById) {
  return lines.flatMap((line) => {
    const product = productsById.get(line.productId)
    return product ? [{ ...line, product, lineTotal: product.price * line.quantity }] : []
  })
}

export function getSubtotal(resolvedLines) {
  let subtotal = 0
  for (const line of resolvedLines) subtotal += line.lineTotal
  return subtotal
}
