import { useState } from 'react'

/** Product image with a neutral fallback when the file is missing or fails to load. */
export function ProductImage({ src, alt, className = '' }) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div className={`product-image product-image--fallback ${className}`} role="img" aria-label={`${alt} (image unavailable)`}>
        <span aria-hidden="true">Image unavailable</span>
      </div>
    )
  }
  return (
    <img
      className={`product-image ${className}`}
      src={src}
      alt={alt}
      width="400"
      height="300"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
