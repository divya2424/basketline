import { pino, type Logger } from 'pino'

export type { Logger }

// Secrets must never reach logs (PRD §8): passwords, tokens, auth headers.
const REDACT_PATHS = [
  'password',
  '*.password',
  'body.password',
  'req.body.password',
  'accessToken',
  '*.accessToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
]

export function createLogger(service: string): Logger {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  })
}
