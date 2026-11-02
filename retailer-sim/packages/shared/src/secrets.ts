/**
 * Basketline API keys at rest and on the retailer's Kafka topics: sealed with
 * AES-256-GCM under the retailer's secrets key (RETAILER_SECRETS_KEY, 32 bytes,
 * base64), which only its own services hold.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const keyFrom = (secretsKey: string) => {
  const key = Buffer.from(secretsKey, 'base64')
  if (key.length !== 32) throw new Error('RETAILER_SECRETS_KEY must be 32 bytes, base64 (openssl rand -base64 32)')
  return key
}

/** base64url(iv | tag | ciphertext). */
export function sealSecret(plain: string, secretsKey: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secretsKey), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

/** Throws if the value was changed or sealed under another key. */
export function openSecret(sealed: string, secretsKey: string): string {
  const bytes = Buffer.from(sealed, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secretsKey), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}
