/**
 * The simulated retailer's own secrets, apart from Basketline's: the ES256 key
 * pair its auth service signs its customers' and staff's tokens with
 * (keys/jwt-private.pem, keys/jwt-public.pem), and the key that seals the
 * Basketline API keys it keeps (keys/secrets.key). Existing ones are kept
 * unless --force is passed.
 *
 *   pnpm keys
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'

const dir = path.join(import.meta.dirname, '..', 'keys')
const privatePath = path.join(dir, 'jwt-private.pem')

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Keys already exist in ${dir} (use --force to replace them).`)
} else {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  await mkdir(dir, { recursive: true })
  await writeFile(privatePath, await exportPKCS8(privateKey), { mode: 0o600 })
  // Readable by the container user: the public half, and the sealing key its services share.
  await writeFile(path.join(dir, 'jwt-public.pem'), await exportSPKI(publicKey), { mode: 0o644 })
  await writeFile(path.join(dir, 'secrets.key'), randomBytes(32).toString('base64'), { mode: 0o644 })
  console.log(`Wrote the retailer's keys to ${dir}`)
}
