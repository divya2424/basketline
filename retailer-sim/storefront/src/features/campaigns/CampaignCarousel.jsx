import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { AnalyticsWrapper, useAnalytics } from '../../components/common/AnalyticsWrapper.jsx'
import { EVENT_NAMES } from '../../analytics/eventSchema.js'
import { useInView } from '../../analytics/useInView.js'
import { ProductCard } from '../products/ProductCard.jsx'
import { buildCarouselItems, chunk, groupByCampaign } from './carouselItems.js'

const chevronLeft = (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6" />
  </svg>
)
const chevronRight = (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6" />
  </svg>
)

export const ITEMS_PER_SLIDE = 3

/** Campaign cards have no cart controls: a click opens the product's page (an ad click), where it can be added. */
export function CampaignCarousel({ campaigns, productsById, itemsPerSlide = ITEMS_PER_SLIDE }) {
  const slides = useMemo(
    () => chunk(buildCarouselItems(campaigns, productsById), itemsPerSlide),
    [campaigns, productsById, itemsPerSlide],
  )
  if (slides.length === 0) return null
  return (
    <AnalyticsWrapper featureName="campaign_carousel">
      <Carousel slides={slides} />
    </AnalyticsWrapper>
  )
}

function Carousel({ slides }) {
  const { track } = useAnalytics()
  const [activeIndex, setActiveIndex] = useState(0)
  const viewportRef = useRef(null)
  const inView = useInView(viewportRef)
  // Slide shown during the current visibility occurrence; reset when the
  // carousel scrolls out of view so coming back counts as a new impression.
  const impressedSlideRef = useRef(null)

  const count = slides.length
  const index = Math.min(activeIndex, count - 1)
  const slide = slides[index]

  // One impression per campaign visible on the slide, carrying only that
  // campaign's products on this slide.
  const reportImpressions = useEffectEvent((slideIndex) => {
    for (const group of groupByCampaign(slides[slideIndex])) {
      track(EVENT_NAMES.CAMPAIGN_IMPRESSION, {
        campaignId: group.campaignId,
        productIds: group.productIds,
        position: slideIndex + 1,
        slots: group.slots,
        source: 'home_carousel',
      })
    }
  })

  // Primitive deps only: re-renders with the same slide and visibility are no-ops,
  // and the ref guard absorbs StrictMode's double effect run.
  useEffect(() => {
    if (!inView) {
      impressedSlideRef.current = null
      return
    }
    if (impressedSlideRef.current === index) return
    impressedSlideRef.current = index
    reportImpressions(index)
  }, [inView, index])

  const goTo = (nextIndex, direction) => {
    const target = (nextIndex + count) % count
    if (target === index) return
    setActiveIndex(target)
    track(EVENT_NAMES.CAMPAIGN_NAVIGATION, {
      fromSlide: index + 1,
      toSlide: target + 1,
      campaignIds: groupByCampaign(slides[target]).map((group) => group.campaignId),
      direction,
      position: target + 1,
    })
  }

  const handleKeyDown = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'ArrowRight') goTo(index + 1, 'next')
    if (event.key === 'ArrowLeft') goTo(index - 1, 'previous')
  }

  return (
    // Focusable so the arrow keys move between slides.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      className="campaign-carousel"
      aria-roledescription="carousel"
      aria-label="Promotional campaigns"
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="campaign-carousel__header">
        <h2 className="campaign-carousel__title">Deals &amp; campaigns</h2>
        <p className="campaign-carousel__eyebrow">
          {index + 1} of {count}
        </p>
      </div>
      <div
        className="campaign-slide"
        ref={viewportRef}
        role="group"
        aria-roledescription="slide"
        aria-label={`${index + 1} of ${count}`}
        aria-live="polite"
      >
        <ul className="campaign-slide__products">
          {slide.map((item, slot) => (
            <li key={item.key} className="campaign-item" data-campaign-id={item.campaign.id}>
              <p className="campaign-tag">{item.campaign.title}</p>
              <AnalyticsWrapper featureName="product_card" properties={{ source: 'home_carousel', campaignId: item.campaign.id }}>
                <ProductCard product={item.product} position={slot + 1} />
              </AnalyticsWrapper>
            </li>
          ))}
        </ul>
      </div>

      {count > 1 ? (
        <div className="campaign-carousel__controls">
          <button type="button" className="icon-btn" onClick={() => goTo(index - 1, 'previous')} aria-label="Previous slide">
            {chevronLeft}
          </button>
          <div className="campaign-carousel__dots">
            {slides.map((_, dotIndex) => (
              <button
                key={dotIndex}
                type="button"
                className="dot"
                aria-label={`Show slide ${dotIndex + 1}`}
                aria-current={dotIndex === index ? 'true' : undefined}
                onClick={() => goTo(dotIndex, 'indicator')}
              />
            ))}
          </div>
          <button type="button" className="icon-btn" onClick={() => goTo(index + 1, 'next')} aria-label="Next slide">
            {chevronRight}
          </button>
        </div>
      ) : null}
    </section>
  )
}
