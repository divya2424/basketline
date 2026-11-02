import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { CampaignCarousel } from './CampaignCarousel.jsx'
import { campaigns } from './campaignData.js'
import { buildCarouselItems, chunk, groupByCampaign } from './carouselItems.js'
import { products, productsById } from '../products/productData.js'
import { AnalyticsWrapper } from '../../components/common/AnalyticsWrapper.jsx'
import { setAllVisible, setInitiallyVisible } from '../../test/intersectionObserver.js'
import { localCollector } from '../../analytics/analytics.js'

function renderCarousel(list = campaigns) {
  const ui = (items) => (
    <StrictMode>
      <MemoryRouter>
        <AnalyticsWrapper pageName="home">
          <CampaignCarousel campaigns={items} productsById={productsById} />
        </AnalyticsWrapper>
      </MemoryRouter>
    </StrictMode>
  )
  const result = render(ui(list))
  return { ...result, rerenderWith: (items) => result.rerender(ui(items)) }
}

const impressions = () => localCollector.getEvents().filter((e) => e.eventName === 'campaign_impression')
const slide = () => screen.getByRole('group', { name: /of \d+$/ })
const slideCampaignIds = () => [...slide().querySelectorAll('[data-campaign-id]')].map((li) => li.dataset.campaignId)
const slideProductNames = () => within(slide()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)

describe('campaign data', () => {
  it('has at least two campaigns whose product references all resolve', () => {
    expect(campaigns.length).toBeGreaterThanOrEqual(2)
    for (const campaign of campaigns) {
      for (const id of campaign.productIds) expect(productsById.has(id), `${campaign.id} → ${id}`).toBe(true)
    }
  })

  it('allows campaigns of different sizes and products outside any campaign', () => {
    expect(new Set(campaigns.map((c) => c.productIds.length)).size).toBeGreaterThan(1)
    const inCampaigns = new Set(campaigns.flatMap((c) => c.productIds))
    expect(products.some((p) => !inCampaigns.has(p.id))).toBe(true)
  })
})

describe('buildCarouselItems', () => {
  const list = [
    { id: 'a', title: 'A', type: 'product_collection', productIds: ['product_001', 'product_002', 'product_003'] },
    { id: 'b', title: 'B', type: 'product_collection', productIds: ['product_004', 'product_002'] },
    { id: 'c', title: 'C', type: 'product_collection', productIds: ['missing', 'product_005'] },
    { id: 'v', title: 'Video', type: 'video_banner', productIds: ['product_006'] },
  ]

  it('interleaves campaigns round-robin, dedupes products, skips missing and unsupported', () => {
    const items = buildCarouselItems(list, productsById)
    expect(items.map((i) => `${i.campaign.id}:${i.product.id}`)).toEqual([
      'a:product_001',
      'b:product_004',
      'a:product_002',
      'c:product_005',
      'a:product_003',
    ])
  })

  it('groups a slide by campaign with product IDs and slot numbers', () => {
    const [first] = chunk(buildCarouselItems(list, productsById), 3)
    expect(groupByCampaign(first)).toEqual([
      { campaignId: 'a', productIds: ['product_001', 'product_002'], slots: [1, 3] },
      { campaignId: 'b', productIds: ['product_004'], slots: [2] },
    ])
  })
})

describe('CampaignCarousel', () => {
  it('mixes products from different campaigns on the first slide, each tagged with its campaign', () => {
    renderCarousel()
    expect(slideProductNames()).toEqual(['Aurora Wireless Earbuds', 'Drift Cotton Hoodie', 'Lumen LED Desk Lamp'])
    expect(slideCampaignIds()).toEqual(['campaign_001', 'campaign_002', 'campaign_003'])
    for (const tag of ['Featured Picks', 'Festive Gifting', 'Work From Home Essentials']) {
      expect(within(slide()).getByText(tag)).toBeInTheDocument()
    }
  })

  it('navigates with next, previous and indicator controls, wrapping around', async () => {
    renderCarousel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Next slide' }))
    expect(slide()).toHaveAccessibleName('2 of 3')
    expect(slideProductNames()).toEqual(['Summit 30L Travel Backpack', 'Nimbus Smartwatch', 'Pulse Bluetooth Speaker'])
    await user.click(screen.getByRole('button', { name: 'Previous slide' }))
    await user.click(screen.getByRole('button', { name: 'Previous slide' }))
    expect(slide()).toHaveAccessibleName('3 of 3')
    await user.click(screen.getByRole('button', { name: 'Show slide 2' }))
    expect(slide()).toHaveAccessibleName('2 of 3')

    const nav = localCollector.getEvents().filter((e) => e.eventName === 'campaign_navigation')
    expect(nav.map((e) => e.properties.direction)).toEqual(['next', 'previous', 'previous', 'indicator'])
    expect(nav[0].properties).toMatchObject({ fromSlide: 1, toSlide: 2, campaignIds: ['campaign_004', 'campaign_001', 'campaign_002'] })
  })

  it('supports arrow-key navigation when the carousel is focused', async () => {
    renderCarousel()
    screen.getByRole('region', { name: 'Promotional campaigns' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(slide()).toHaveAccessibleName('2 of 3')
  })

  it('records one impression per campaign visible on the slide, with only its visible products', () => {
    renderCarousel()
    expect(impressions().map((e) => e.properties)).toEqual([
      { campaignId: 'campaign_001', productIds: ['product_001'], position: 1, slots: [1], source: 'home_carousel' },
      { campaignId: 'campaign_002', productIds: ['product_004'], position: 1, slots: [2], source: 'home_carousel' },
      { campaignId: 'campaign_003', productIds: ['product_006'], position: 1, slots: [3], source: 'home_carousel' },
    ])
    expect(impressions()[0]).toMatchObject({ featureName: 'campaign_carousel', pageName: 'home' })
  })

  it('does not record impressions while the carousel is off-screen', () => {
    setInitiallyVisible(false)
    renderCarousel()
    expect(impressions()).toHaveLength(0)
    setAllVisible(true)
    expect(impressions()).toHaveLength(3)
  })

  it('records impressions for each newly shown slide', async () => {
    renderCarousel()
    await userEvent.click(screen.getByRole('button', { name: 'Next slide' }))
    expect(impressions().slice(3).map((e) => e.properties.campaignId)).toEqual(['campaign_004', 'campaign_001', 'campaign_002'])
    expect(impressions().slice(3).every((e) => e.properties.position === 2)).toBe(true)
  })

  it('does not duplicate impressions on re-renders, but counts a new visibility occurrence', () => {
    const { rerenderWith } = renderCarousel()
    rerenderWith(campaigns)
    rerenderWith(campaigns)
    expect(impressions()).toHaveLength(3)

    setAllVisible(false)
    setAllVisible(true)
    expect(impressions()).toHaveLength(6)
  })

  it('has no cart controls; a card click opens the product, tagged with the card’s own campaign', async () => {
    renderCarousel()
    expect(within(slide()).queryByRole('button', { name: /to cart/ })).not.toBeInTheDocument()
    await userEvent.click(within(slide()).getByRole('link', { name: 'Drift Cotton Hoodie' }))
    const click = localCollector.getEvents().find((e) => e.eventName === 'product_click')
    expect(click.properties).toMatchObject({ productId: 'product_004', campaignId: 'campaign_002', source: 'home_carousel', position: 2 })
  })

  it('renders nothing when no campaign has displayable products', () => {
    const { container } = renderCarousel([{ id: 'x', title: 'X', type: 'video_banner', productIds: [] }])
    expect(container).toBeEmptyDOMElement()
  })
})
