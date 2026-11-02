import { hash, verify } from '@node-rs/argon2'

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
// algorithm 2 = Algorithm.Argon2id (a const enum, which Node's type stripping can't inline).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

// Verified against when the username doesn't exist, so response time doesn't
// reveal which usernames are registered.
let dummyHash: Promise<string> | null = null
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('not-a-real-password-placeholder')
  return dummyHash
}
