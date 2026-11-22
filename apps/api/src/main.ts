import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

import { env } from './config/env.js'
import { createApp } from './http/app.js'
import { logger } from './infra/logger.js'
import { InFlightOperations } from './infra/in-flight-operations.js'
import { prisma } from './infra/prisma.js'
import { redis } from './infra/redis.js'
import { SocketGateway } from './realtime/socketGateway.js'
import { closeRealtimeServer, createRealtimeServer } from './realtime/server.js'
import type { RealtimeServer } from './realtime/types.js'

const SHUTDOWN_TIMEOUT_MS = 15_000
const READINESS_WITHDRAWAL_MS = 250

const operations = new InFlightOperations()
const gateway = new SocketGateway()
let shuttingDown = false
let realtimeServer: RealtimeServer | undefined
let shutdownPromise: Promise<void> | undefined
let startupPromise: Promise<void> = Promise.resolve()

const app = createApp({
  gateway,
  isShuttingDown: () => shuttingDown,
})
const httpServer = createServer(app)

async function start(): Promise<void> {
  realtimeServer = await createRealtimeServer(httpServer, { operations })
  gateway.attach(realtimeServer)

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      httpServer.off('error', onError)
      resolve()
    }

    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(env.PORT)
  })

  logger.info({ port: env.PORT }, 'API server started')
}

function closeHttpServer(): Promise<void> {
  if (!httpServer.listening) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
  if (shutdownPromise) {
    return shutdownPromise
  }

  shuttingDown = true
  operations.stopAccepting()
  logger.info({ signal }, 'Stopping API server')

  const hardTimeout = setTimeout(() => {
    logger.fatal({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'API shutdown timed out')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)

  shutdownPromise = (async () => {
    try {
      await startupPromise.catch(() => undefined)
      if (httpServer.listening) {
        await delay(READINESS_WITHDRAWAL_MS)
      }
      const errors: unknown[] = []
      const httpClosePromise = closeHttpServer().catch((error: unknown) => {
        errors.push(error)
      })

      await operations.waitForIdle()

      if (realtimeServer) {
        try {
          await closeRealtimeServer(realtimeServer, { waitForPendingPresence: true })
        } catch (error) {
          errors.push(error)
        }
      }
      await operations.waitForIdle()
      await httpClosePromise

      const resourceResults = await Promise.allSettled([closeRedis(), prisma.$disconnect()])
      errors.push(
        ...resourceResults
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(({ reason }) => reason),
      )

      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more API resources failed to close')
      }
      logger.info({ signal }, 'API server stopped')
    } catch (error) {
      logger.error({ err: error, signal }, 'API server shutdown failed')
      process.exitCode = 1
    } finally {
      clearTimeout(hardTimeout)
    }
  })()

  return shutdownPromise
}

async function closeRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit()
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ err: reason }, 'Unhandled promise rejection')
  void shutdown('unhandledRejection', 1)
})
process.on('uncaughtException', (error: Error) => {
  logger.fatal({ err: error }, 'Uncaught exception')
  void shutdown('uncaughtException', 1)
})

startupPromise = start()
try {
  await startupPromise
} catch (error) {
  logger.fatal({ err: error }, 'API server failed to start')
  await shutdown('startup failure', 1)
}
