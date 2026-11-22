import { Queue, Worker } from 'bullmq'
import { Emitter } from '@socket.io/redis-emitter'
import type { ServerToClientEvents } from '@realtime-messaging/contracts'
import { Redis } from 'ioredis'

import { env } from './config/env.js'
import { logger } from './infra/logger.js'
import { prisma } from './infra/prisma.js'
import { redis } from './infra/redis.js'
import { run as flushLastSeen } from './jobs/last-seen-flush.js'
import { run as sweepPresence } from './jobs/presence-sweep.js'
import { run as cleanupSessions } from './jobs/session-cleanup.js'
import { run as reconcileUnread } from './jobs/unread-reconcile.js'

const QUEUE_NAME = 'messaging-maintenance'
const JOB_SCHEDULES = [
  { name: 'last-seen-flush', repeat: { every: 30_000 } },
  { name: 'session-cleanup', repeat: { every: 60 * 60 * 1000 } },
  { name: 'unread-reconcile', repeat: { pattern: '0 0 * * *' } },
  { name: 'presence-sweep', repeat: { every: 30_000 } },
] as const

const emitterRedis = redis.duplicate()
const queueRedis = redis.duplicate()
const workerRedis = redis.duplicate()
const emitter = new Emitter<ServerToClientEvents>(emitterRedis)
const queue = new Queue(QUEUE_NAME, {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
})

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    switch (job.name) {
      case 'last-seen-flush':
        return flushLastSeen({ prisma, redis })
      case 'session-cleanup':
        return cleanupSessions({ prisma })
      case 'unread-reconcile':
        return reconcileUnread({ logger, prisma })
      case 'presence-sweep':
        return sweepPresence({ emitter, prisma, redis })
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`)
    }
  },
  { connection: workerRedis, concurrency: 1 },
)

for (const [name, connection] of [
  ['shared', redis],
  ['emitter', emitterRedis],
  ['queue', queueRedis],
  ['worker', workerRedis],
] as const) {
  connection.on('error', (error: Error) => {
    logger.error({ err: error, connection: name }, 'Worker Redis connection error')
  })
}

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Maintenance job completed')
})
worker.on('failed', (job, error) => {
  logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'Maintenance job failed')
})
worker.on('error', (error) => {
  logger.error({ err: error }, 'BullMQ worker error')
})

let shutdownPromise: Promise<void> | undefined

async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise
  }

  logger.info({ signal }, 'Stopping maintenance worker')
  shutdownPromise = closeResources()
  await shutdownPromise
}

function handleShutdown(signal: string): void {
  void shutdown(signal).catch((error: unknown) => {
    logger.error({ err: error, signal }, 'Failed to stop maintenance worker')
    process.exitCode = 1
  })
}

process.once('SIGINT', () => handleShutdown('SIGINT'))
process.once('SIGTERM', () => handleShutdown('SIGTERM'))

try {
  await Promise.all([
    redis.ping(),
    emitterRedis.ping(),
    queue.waitUntilReady(),
    worker.waitUntilReady(),
  ])
  await Promise.all(
    JOB_SCHEDULES.map(({ name, repeat }) =>
      queue.upsertJobScheduler(name, repeat, { name, data: {} }),
    ),
  )
  logger.info(
    { queueName: QUEUE_NAME, schedules: JOB_SCHEDULES, instanceId: env.INSTANCE_ID },
    'Maintenance worker started',
  )
} catch (error) {
  try {
    await shutdown('startup failure')
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Worker startup and cleanup failed', {
      cause: cleanupError,
    })
  }
  throw error
}

async function closeResources(): Promise<void> {
  const queueResults = await Promise.allSettled([worker.close(), queue.close()])
  const connectionResults = await Promise.allSettled([
    closeRedisConnection(emitterRedis),
    closeRedisConnection(queueRedis),
    closeRedisConnection(workerRedis),
    closeRedisConnection(redis),
    prisma.$disconnect(),
  ])
  const errors = [...queueResults, ...connectionResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(({ reason }) => reason)

  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more worker resources failed to close')
  }
}

async function closeRedisConnection(connection: Redis): Promise<void> {
  if (connection.status !== 'end') {
    await connection.quit()
  }
}
