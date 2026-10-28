/**
 * Creates the ES256 key pair used to sign (auth-service) and verify (all
 * services) access tokens: keys/jwt-private.pem and keys/jwt-public.pem.
 * Existing keys are kept unless --force is passed.
 *
 *   npm run keys
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'

const dir = path.join(import.meta.dirname, '..', 'keys')
const privatePath = path.join(dir, 'jwt-private.pem')
const publicPath = path.join(dir, 'jwt-public.pem')

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Keys already exist in ${dir} (use --force to replace them).`)
} else {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  await mkdir(dir, { recursive: true })
  await writeFile(privatePath, await exportPKCS8(privateKey), { mode: 0o600 })
  // Readable by the container user; it's the public half.
  await writeFile(publicPath, await exportSPKI(publicKey), { mode: 0o644 })
  console.log(`Wrote ${privatePath} and ${publicPath}`)
}
