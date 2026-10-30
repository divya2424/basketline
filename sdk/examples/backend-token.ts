/**
 * Example: the endpoint on a vendor's backend that hands the Basketline SDK a
 * shopper token for the signed-in customer. The API key stays on the server.
 *
 *   BASKETLINE_API_URL=https://api.basketline.io/api/v1
 *   BASKETLINE_TENANT_ID=<your tenant ID>
 *   BASKETLINE_API_KEY=bl_sk_…            (from create-api-key)
 *
 * The page calls it with the SDK's visitor ID, then passes the result to
 * bl.identify({ userId, getToken }).
 */
import type { Request, Response } from 'express'

interface SignedInRequest extends Request {
  /** Whatever your own session middleware sets for a signed-in customer. */
  user?: { id: string }
}

export async function basketlineToken(req: SignedInRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'sign in first' })
    return
  }
  const response = await fetch(`${process.env.BASKETLINE_API_URL}/auth/shopper-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      tenant_id: process.env.BASKETLINE_TENANT_ID!,
      Authorization: `ApiKey ${process.env.BASKETLINE_API_KEY}`,
    },
    // customerId: your ID for the customer. visitorId: the SDK's, so their earlier visits count as theirs.
    body: JSON.stringify({ customerId: req.user.id, visitorId: req.body?.visitorId }),
  })
  if (!response.ok) {
    res.status(502).json({ error: 'Basketline token unavailable' })
    return
  }
  const { shopperToken, userId } = (await response.json()) as { shopperToken: string; userId: string }
  res.json({ token: shopperToken, userId })
}
