// How each campaign type contributes products to the carousel. Register a
// function here to support a new campaign type; unknown types contribute nothing.
const productIdsByCampaignType = {
  product_collection: (campaign) => campaign.productIds,
}

/**
 * Interleaves products from all campaigns round-robin (1st product of each
 * campaign, then the 2nd of each, ...), so neighbouring cards come from
 * different campaigns. Each product appears once, attributed to the first
 * campaign it is reached through; references to missing products are skipped.
 */
export function buildCarouselItems(campaigns, productsById) {
  const sources = campaigns.map((campaign) => ({
    campaign,
    productIds: productIdsByCampaignType[campaign.type]?.(campaign) ?? [],
  }))
  let longest = 0
  for (const source of sources) longest = Math.max(longest, source.productIds.length)

  const seen = new Set()
  const items = []
  for (let round = 0; round < longest; round += 1) {
    for (const { campaign, productIds } of sources) {
      const productId = productIds[round]
      const product = productId ? productsById.get(productId) : undefined
      if (!product || seen.has(productId)) continue
      seen.add(productId)
      items.push({ key: `${campaign.id}:${productId}`, campaign: { id: campaign.id, title: campaign.title }, product })
    }
  }
  return items
}

export function chunk(items, size) {
  const slides = []
  for (let i = 0; i < items.length; i += size) slides.push(items.slice(i, i + size))
  return slides
}

/** Campaigns on a slide, in order of first appearance, with their visible product IDs. */
export function groupByCampaign(slideItems) {
  const groups = new Map()
  slideItems.forEach((item, index) => {
    const group = groups.get(item.campaign.id) ?? { campaignId: item.campaign.id, productIds: [], slots: [] }
    group.productIds.push(item.product.id)
    group.slots.push(index + 1)
    groups.set(item.campaign.id, group)
  })
  return [...groups.values()]
}
