import type { Server as HttpServer } from 'node:http'

import type { PrismaClient } from '@prisma/client'
import { Server, type DefaultEventsMap } from 'socket.io'

import { env } from '../config/env.js'
import { logger } from '../infra/logger.js'
import { prisma } from '../infra/prisma.js'
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

export type RealtimeServerDependencies = {
  prisma?: Pick<PrismaClient, 'participant'>
  authenticate?: typeof authenticateAccessToken
}

export function createRealtimeServer(
  httpServer: HttpServer,
  dependencies: RealtimeServerDependencies = {},
): RealtimeServer {
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
  const messages = new MessagesService()
  const messageStatus = new MessageStatusService()
  io.on('connection', (socket) => {
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

    socket.once('disconnect', () => {
      if (expiryTimer) {
        clearTimeout(expiryTimer)
      }
      void presence.disconnect(socket.data.userId, socket.id).catch((error: unknown) => {
        logger.error(
          { err: error, socketId: socket.id, userId: socket.data.userId },
          'Failed to update presence after disconnect',
        )
      })
    })
    disconnectAtExpiry()

    void initializeConnection(socket, database, presence, broadcastPresence).catch(
      (error: unknown) => {
        logger.error(
          { err: error, socketId: socket.id, userId: socket.data.userId },
          'Failed to initialize socket connection',
        )
        socket.disconnect(true)
      },
    )

    handle(socket, 'message:send', SendMessageInput, async (input) => {
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
        io.to(`conv:${input.conversationId}`).emit('message:new', { message: result.message })
      }
      socket.to(`conv:${input.conversationId}`).emit('typing', {
        conversationId: input.conversationId,
        userId: socket.data.userId,
        isTyping: false,
      })
      return result
    })

    handle(socket, 'message:delete', MessageDeleteInput, async (input) => {
      const result = await messages.deleteMessage(socket.data.userId, input.messageId)
      if (result.deleted) {
        io.to(`conv:${result.conversationId}`).emit('message:deleted', {
          conversationId: result.conversationId,
          messageId: result.messageId,
          seq: result.seq,
        })
      }
      return { messageId: result.messageId, seq: result.seq }
    })

    handle(socket, 'message:delivered', MessageDeliveredInput, async (input) => {
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
    })

    handle(socket, 'conversation:read', ConversationReadInput, async (input) => {
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
    })

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

    handle(socket, 'typing:start', TypingInput, async ({ conversationId }) => {
      await handleTyping(conversationId, true)
    })
    handle(socket, 'typing:stop', TypingInput, async ({ conversationId }) => {
      await handleTyping(conversationId, false)
    })

    handle(socket, 'presence:ping', PresencePingInput, async () => {
      const becameOnline = await presence.heartbeat(socket.data.userId, socket.id)
      if (becameOnline) {
        await broadcastPresence(socket.data.userId, true, null)
      }
    })
  })

  return io
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
