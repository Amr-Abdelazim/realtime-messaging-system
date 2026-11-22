import type { Server as HttpServer } from 'node:http'

import type { PrismaClient } from '@prisma/client'
import { Server, type DefaultEventsMap } from 'socket.io'

import { env } from '../config/env.js'
import { logger } from '../infra/logger.js'
import { prisma } from '../infra/prisma.js'
import { authenticateAccessToken } from '../modules/auth/access.js'
import { installSocketAuth } from './auth.js'
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
    })
    disconnectAtExpiry()

    void initializeConnection(socket, dependencies.prisma ?? prisma).catch((error: unknown) => {
      logger.error(
        { err: error, socketId: socket.id, userId: socket.data.userId },
        'Failed to initialize socket connection',
      )
      socket.disconnect(true)
    })
  })

  return io
}

async function initializeConnection(
  socket: RealtimeSocket,
  database: Pick<PrismaClient, 'participant'>,
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

  socket.emit('ready', { serverTime: new Date().toISOString() })
}
