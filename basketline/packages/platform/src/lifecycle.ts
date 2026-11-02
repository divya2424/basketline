/**
 * Graceful shutdown, in this order:
 *   1. readiness → 503, so load balancers / Kubernetes stop routing new traffic
 *   2. wait drainDelayMs for them to notice
 *   3. stop accepting connections, let in-flight requests finish, drop idle keep-alive sockets
 *   4. run closers in the order given (e.g. Kafka, then the database), each logged
 *   5. exit; a hard timeout forces exit(1) if anything hangs
 * Crashes (uncaughtException / unhandledRejection) take the same path and exit 1.
 */
import type { Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { intEnv } from './config.ts'
import type { Health } from './health.ts'
import type { Logger } from './logger.ts'

export interface Closer {
  name: string
  close: () => Promise<unknown> | unknown
}

export interface ShutdownOptions {
  logger: Logger
  server: Server
  health: Health
  /** Run in this order after HTTP has stopped. */
  closers: Closer[]
  drainDelayMs?: number
  timeoutMs?: number
  /** Listen for SIGTERM/SIGINT and crashes (disable in tests). */
  registerProcessHandlers?: boolean
  exit?: (code: number) => void
}

export function handleShutdown({
  logger,
  server,
  health,
  closers,
  drainDelayMs = intEnv('SHUTDOWN_DRAIN_MS', 5_000),
  timeoutMs = intEnv('SHUTDOWN_TIMEOUT_MS', 25_000),
  registerProcessHandlers = true,
  exit = (code) => process.exit(code),
}: ShutdownOptions): (reason: string, exitCode?: number) => Promise<void> {
  let inProgress: Promise<void> | null = null

  const stopHttp = (deadline: number) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Keep-alive sockets with no request in flight would otherwise hold close() open.
      server.closeIdleConnections()
      const force = setTimeout(() => {
        logger.warn('requests still running at the HTTP deadline; closing their connections')
        server.closeAllConnections()
      }, Math.max(0, deadline - Date.now()))
      force.unref()
      server.once('close', () => clearTimeout(force))
    })

  const run = async (reason: string, exitCode: number) => {
    const started = Date.now()
    const hardStop = setTimeout(() => {
      logger.fatal({ reason, timeoutMs }, 'shutdown timed out; forcing exit')
      exit(1)
    }, timeoutMs)
    hardStop.unref()

    health.markShuttingDown()
    logger.info({ reason, drainDelayMs }, 'shutting down: readiness now failing, draining traffic')
    // Skip the drain on a crash: the process state can't be trusted.
    if (exitCode === 0 && drainDelayMs > 0) await sleep(drainDelayMs)

    // Leave half of the remaining budget for the closers.
    await stopHttp(started + timeoutMs / 2)
    logger.info('HTTP server closed')

    for (const { name, close } of closers) {
      const at = Date.now()
      try {
        await close()
        logger.info({ resource: name, ms: Date.now() - at }, 'closed')
      } catch (error) {
        logger.error({ err: error, resource: name }, 'error while closing')
      }
    }

    clearTimeout(hardStop)
    logger.info({ reason, ms: Date.now() - started }, 'shutdown complete')
    exit(exitCode)
  }

  const shutdown = (reason: string, exitCode = 0) => {
    inProgress ??= run(reason, exitCode)
    return inProgress
  }

  if (registerProcessHandlers) {
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.on('uncaughtException', (error) => {
      logger.fatal({ err: error }, 'uncaught exception')
      void shutdown('uncaughtException', 1)
    })
    process.on('unhandledRejection', (error) => {
      logger.fatal({ err: error }, 'unhandled promise rejection')
      void shutdown('unhandledRejection', 1)
    })
  }
  return shutdown
}
