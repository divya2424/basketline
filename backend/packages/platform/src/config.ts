import { readFileSync } from 'node:fs'

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`Missing required environment variable ${name}`)
  return value
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new Error(`Environment variable ${name} must be an integer`)
  return value
}

/** Reads a secret from NAME, or from the file at NAME_FILE (Docker/K8s secrets). */
export function secretEnv(name: string): string {
  const file = process.env[`${name}_FILE`]
  if (file) return readFileSync(file, 'utf8')
  return requireEnv(name)
}

export function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}
