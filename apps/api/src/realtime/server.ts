import type { Server as HttpServer } from 'node:http'

import type { PrismaClient } from '@prisma/client'
import { createAdapter } from '@socket.io/redis-adapter'
import { Redis } from 'ioredis'
import { Server, type DefaultEventsMap } from 'socket.io'

import { env } from '../config/env.js'
import { logger } from '../infra/logger.js'
import { prisma } from '../infra/prisma.js'
import { redis } from '../infra/redis.js'
import { messageSendDuration, messagesSent, socketsConnected } from '../infra/metrics.js'
import type { InFlightOperations } from '../infra/in-flight-operations.js'
import { authenticateAccessToken } from '../modules/auth/access.js'
import { MessagesService } from '../modules/messages/messages.service.js'
import { MessageStatusService } from '../modules/messages/status.service.js'
import { PresenceService } from '../modules/presence/presence.service.js'
import { RateLimitedError } from '../http/errors/index.js'
import { rateLimit } from '../infra/rateLimit.js'
import {
  ConversationReadInput,
  MessageDeleteInput,
  MessageDeliveredInput,
  PresencePingInput,
  SendMessageInput,
  TypingInput,
} from '@realtime-messaging/contracts'
import { installSocketAuth } from './auth.js'
import { handle } from './handler.js'
import type { RealtimeServer, RealtimeSocket, SocketData } from './types.js'
import type { ClientToServerEvents, ServerToClientEvents } from '@realtime-messaging/contracts'

const MAX_TIMEOUT = 2_147_483_647

type RealtimeResources = {
  clients: [Redis, Redis]
  pendingTasks: Set<Promise<void>>
  presence: PresenceService
}

const realtimeResources = new WeakMap<RealtimeServer, RealtimeResources>()

export type RealtimeServerDependencies = {
  prisma?: Pick<PrismaClient, 'participant'>
  authenticate?: typeof authenticateAccessToken
  operations?: InFlightOperations
}

export type RealtimeServerCloseOptions = {
  waitForPendingPresence?: boolean
}

export async function createRealtimeServer(
  httpServer: HttpServer,
  dependencies: RealtimeServerDependencies = {},
): Promise<RealtimeServer> {
  const publisher = redis.duplicate()
  const subscriber = redis.duplicate()
  publisher.on('error', (error: Error) => {
    logger.error({ err: error }, 'Socket.IO Redis publisher error')
  })
  subscriber.on('error', (error: Error) => {
    logger.error({ err: error }, 'Socket.IO Redis subscriber error')
  })

  try {
    await Promise.all([waitForRedisReady(publisher), waitForRedisReady(subscriber)])
  } catch (error) {
    publisher.disconnect()
    subscriber.disconnect()
    throw error
  }

  const allowedOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim())
  const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(
    httpServer,
    {
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxHttpBufferSize: 100_000,
      cors: { origin: allowedOrigins },
    },
  )
  io.adapter(createAdapter(publisher, subscriber))

  installSocketAuth(io, dependencies.authenticate ?? authenticateAccessToken)
  const database = dependencies.prisma ?? prisma
  const broadcastPresence = (
    userId: string,
    online: boolean,
    lastSeenAt: string | null,
  ): Promise<void> => broadcastPresenceUpdate(io, database, userId, online, lastSeenAt)
  const presence = new PresenceService((userId, lastSeenAt) =>
    broadcastPresence(userId, false, lastSeenAt),
  )
  const resources: RealtimeResources = {
    clients: [publisher, subscriber],
    pendingTasks: new Set(),
    presence,
  }
  realtimeResources.set(io, resources)
  const messages = new MessagesService()
  const messageStatus = new MessageStatusService()
  io.on('connection', (socket) => {
    const socketLogger = logger.child({ socketId: socket.id, userId: socket.data.userId })
    const releaseInitialization = dependencies.operations?.begin()
    if (dependencies.operations && !releaseInitialization) {
      socket.disconnect(true)
      return
    }

    socketsConnected.inc()
    socketLogger.info('Socket connected')
    const handlerOptions = {
      logger: socketLogger,
      beginOperation: dependencies.operations ? () => dependencies.operations?.begin() : undefined,
    }
    const expiryTime = socket.data.tokenExp * 1000
    let expiryTimer: NodeJS.Timeout | undefined

    const disconnectAtExpiry = () => {
      const remaining = expiryTime - Date.now()
      if (remaining <= 0) {
        socket.disconnect(true)
        return
      }
      expiryTimer = setTimeout(disconnectAtExpiry, Math.min(remaining, MAX_TIMEOUT))
    }

    socket.once('disconnect', (reason) => {
      socketsConnected.dec()
      socketLogger.info({ reason }, 'Socket disconnected')
      if (expiryTimer) {
        clearTimeout(expiryTimer)
      }
      const releaseCleanup = dependencies.operations?.beginCleanup()
      const cleanup = presence
        .disconnect(socket.data.userId, socket.id)
        .catch((error: unknown) => {
          socketLogger.error({ err: error }, 'Failed to update presence after disconnect')
        })
        .finally(() => releaseCleanup?.())
      trackTask(resources.pendingTasks, cleanup)
    })
    disconnectAtExpiry()

    const initialization = initializeConnection(socket, database, presence, broadcastPresence)
      .catch((error: unknown) => {
        socketLogger.error({ err: error }, 'Failed to initialize socket connection')
        socket.disconnect(true)
      })
      .finally(() => releaseInitialization?.())
    trackTask(resources.pendingTasks, initialization)

    handle(
      socket,
      'message:send',
      SendMessageInput,
      async (input) => {
        const startedAt = process.hrtime.bigint()
        try {
          const rateLimitResult = await rateLimit({
            key: `rl:sock:${socket.data.userId}:message:send`,
            limit: 20,
            windowSeconds: 10,
          })
          if (!rateLimitResult.allowed) {
            const retryAfterMs = rateLimitResult.retryAfterSeconds * 1000
            socket.emit('rate_limited', { event: 'message:send', retryAfterMs })
            throw new RateLimitedError('Too many requests', rateLimitResult.retryAfterSeconds)
          }

          const result = await messages.sendMessage(socket.data.userId, input)
          if (!result.duplicate) {
            messagesSent.inc()
            io.to(`conv:${input.conversationId}`).emit('message:new', { message: result.message })
          }
          socket.to(`conv:${input.conversationId}`).emit('typing', {
            conversationId: input.conversationId,
            userId: socket.data.userId,
            isTyping: false,
          })
          return result
        } finally {
          messageSendDuration.observe(Number(process.hrtime.bigint() - startedAt) / 1_000_000_000)
        }
      },
      handlerOptions,
    )

    handle(
      socket,
      'message:delete',
      MessageDeleteInput,
      async (input) => {
        const result = await messages.deleteMessage(socket.data.userId, input.messageId)
        if (result.deleted) {
          io.to(`conv:${result.conversationId}`).emit('message:deleted', {
            conversationId: result.conversationId,
            messageId: result.messageId,
            seq: result.seq,
          })
        }
        return { messageId: result.messageId, seq: result.seq }
      },
      handlerOptions,
    )

    handle(
      socket,
      'message:delivered',
      MessageDeliveredInput,
      async (input) => {
        const result = await messageStatus.markDelivered(
          socket.data.userId,
          input.conversationId,
          input.upToSeq,
        )
        if (result.advanced) {
          io.to(`conv:${input.conversationId}`).emit('message:status', {
            conversationId: input.conversationId,
            userId: socket.data.userId,
            kind: 'delivered',
            upToSeq: result.upToSeq,
          })
        }
        return {}
      },
      handlerOptions,
    )

    handle(
      socket,
      'conversation:read',
      ConversationReadInput,
      async (input) => {
        const result = await messageStatus.markRead(
          socket.data.userId,
          input.conversationId,
          input.upToSeq,
        )
        if (result.advanced) {
          io.to(`conv:${input.conversationId}`).emit('message:status', {
            conversationId: input.conversationId,
            userId: socket.data.userId,
            kind: 'read',
            upToSeq: result.upToSeq,
          })
        }
        return { unreadCount: result.unreadCount }
      },
      handlerOptions,
    )

    const handleTyping = async (conversationId: string, isTyping: boolean): Promise<void> => {
      const room = `conv:${conversationId}`
      if (!socket.rooms.has(room)) {
        return
      }

      const rateLimitResult = await rateLimit({
        key: `rl:sock:${socket.data.userId}:typing`,
        limit: 10,
        windowSeconds: 10,
      })
      if (!rateLimitResult.allowed) {
        return
      }

      socket.to(room).emit('typing', {
        conversationId,
        userId: socket.data.userId,
        isTyping,
      })
    }

    handle(
      socket,
      'typing:start',
      TypingInput,
      async ({ conversationId }) => {
        await handleTyping(conversationId, true)
      },
      handlerOptions,
    )
    handle(
      socket,
      'typing:stop',
      TypingInput,
      async ({ conversationId }) => {
        await handleTyping(conversationId, false)
      },
      handlerOptions,
    )

    handle(
      socket,
      'presence:ping',
      PresencePingInput,
      async () => {
        const becameOnline = await presence.heartbeat(socket.data.userId, socket.id)
        if (becameOnline) {
          await broadcastPresence(socket.data.userId, true, null)
        }
      },
      handlerOptions,
    )
  })

  return io
}

export async function closeRealtimeServer(
  io: RealtimeServer,
  options: RealtimeServerCloseOptions = {},
): Promise<void> {
  const resources = realtimeResources.get(io)
  if (!resources) {
    throw new Error('Realtime server Redis clients were not found')
  }

  for (const socket of io.sockets.sockets.values()) {
    socket.disconnect(true)
  }
  while (resources.pendingTasks.size > 0) {
    await Promise.all(resources.pendingTasks)
  }
  if (options.waitForPendingPresence) {
    await resources.presence.waitForPendingOfflineTransitions()
  }

  realtimeResources.delete(io)
  const errors: unknown[] = []
  try {
    await io.close()
  } catch (error) {
    errors.push(error)
  }
  const results = await Promise.allSettled(resources.clients.map((client) => client.quit()))
  errors.push(
    ...results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(({ reason }) => reason),
  )
  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more realtime resources failed to close')
  }
}

function trackTask(tasks: Set<Promise<void>>, task: Promise<void>): void {
  tasks.add(task)
  void task.then(
    () => tasks.delete(task),
    () => tasks.delete(task),
  )
}

function waitForRedisReady(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      client.off('ready', onReady)
      client.off('error', onError)
    }
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    client.once('ready', onReady)
    client.once('error', onError)
    if (client.status === 'wait') {
      void client.connect().catch(onError)
    }
  })
}

async function initializeConnection(
  socket: RealtimeSocket,
  database: Pick<PrismaClient, 'participant'>,
  presence: PresenceService,
  broadcastPresence: (userId: string, online: boolean, lastSeenAt: string | null) => Promise<void>,
): Promise<void> {
  const userId = socket.data.userId
  await socket.join(`user:${userId}`)
  const memberships = await database.participant.findMany({
    where: { userId, leftAt: null },
    select: { conversationId: true },
  })

  if (!socket.connected || Date.now() >= socket.data.tokenExp * 1000) {
    socket.disconnect(true)
    return
  }
  await socket.join(memberships.map(({ conversationId }) => `conv:${conversationId}`))
  if (!socket.connected || Date.now() >= socket.data.tokenExp * 1000) {
    socket.disconnect(true)
    return
  }

  const becameOnline = await presence.connect(userId, socket.id)
  if (!socket.connected || Date.now() >= socket.data.tokenExp * 1000) {
    await presence.disconnect(userId, socket.id)
    socket.disconnect(true)
    return
  }
  if (becameOnline) {
    await broadcastPresence(userId, true, null)
  }

  socket.emit('ready', { serverTime: new Date().toISOString() })
}

async function broadcastPresenceUpdate(
  io: RealtimeServer,
  database: Pick<PrismaClient, 'participant'>,
  userId: string,
  online: boolean,
  lastSeenAt: string | null,
): Promise<void> {
  const memberships = await database.participant.findMany({
    where: { userId, leftAt: null },
    select: { conversationId: true },
  })
  for (const { conversationId } of memberships) {
    io.to(`conv:${conversationId}`).emit('presence:update', { userId, online, lastSeenAt })
  }
}
