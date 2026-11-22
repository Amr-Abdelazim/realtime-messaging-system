import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { createAdapter } from '@socket.io/redis-adapter'
import { Emitter } from '@socket.io/redis-emitter'
import { Redis } from 'ioredis'
import { Server, type DefaultEventsMap } from 'socket.io'
import { io as createSocketClient } from 'socket.io-client'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { ServerToClientEvents } from '@realtime-messaging/contracts'
import { logger } from '../src/infra/logger.js'
import { prisma } from '../src/infra/prisma.js'
import { redis } from '../src/infra/redis.js'
import { run as flushLastSeen } from '../src/jobs/last-seen-flush.js'
import { run as sweepPresence } from '../src/jobs/presence-sweep.js'
import { run as cleanupSessions } from '../src/jobs/session-cleanup.js'
import { run as reconcileUnread } from '../src/jobs/unread-reconcile.js'

type PresenceUpdate = Parameters<ServerToClientEvents['presence:update']>[0]

const createdUserIds: string[] = []
const createdConversationIds: string[] = []

async function createUser(): Promise<{ id: string }> {
  const suffix = randomUUID().replaceAll('-', '')
  const user = await prisma.user.create({
    data: {
      username: `worker_${suffix}`,
      email: `worker_${suffix}@example.com`,
      passwordHash: 'worker-test-hash',
      displayName: 'Worker test user',
    },
    select: { id: true },
  })
  createdUserIds.push(user.id)
  return user
}

afterEach(async () => {
  if (createdConversationIds.length > 0) {
    await prisma.conversation.deleteMany({
      where: { id: { in: createdConversationIds } },
    })
  }
  if (createdUserIds.length > 0) {
    const redisKeys = createdUserIds.flatMap((userId) => [
      `lastSeen:${userId}`,
      `presence:${userId}`,
      `presence:pending-offline:${userId}`,
    ])
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await redis.del(...redisKeys)
    await redis.srem('lastSeen:dirty', ...createdUserIds)
    await redis.srem('presence:active', ...createdUserIds)
  }
  createdConversationIds.length = 0
  createdUserIds.length = 0
})

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), redis.quit()])
})

describe('worker jobs', () => {
  it('flushes last-seen values from Redis to Postgres in batches', async () => {
    const user = await createUser()
    const userIds = [user.id, ...Array.from({ length: 500 }, () => randomUUID())]
    const timestamp = Date.now() - 10_000
    const pipeline = redis.pipeline()
    for (const userId of userIds) {
      pipeline.set(`lastSeen:${userId}`, String(timestamp), 'EX', 60)
    }
    pipeline.sadd('lastSeen:dirty', ...userIds)
    await pipeline.exec()

    expect(await flushLastSeen({ prisma, redis })).toBe(1)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastSeenAt).toEqual(
      new Date(timestamp),
    )
    expect(await redis.scard('lastSeen:dirty')).toBe(0)
    expect(await flushLastSeen({ prisma, redis })).toBe(0)
  }, 20_000)

  it('deletes expired and long-revoked sessions in batches and is idempotent', async () => {
    const user = await createUser()
    const now = Date.now()
    const expiredSessions = Array.from({ length: 500 }, () => ({
      userId: user.id,
      familyId: randomUUID(),
      tokenHash: randomUUID(),
      expiresAt: new Date(now - 1000),
      revokedAt: null,
      userAgent: null,
      ip: null,
    }))
    const sessions = [
      ...expiredSessions,
      {
        userId: user.id,
        familyId: randomUUID(),
        tokenHash: randomUUID(),
        expiresAt: new Date(now + 60_000),
        revokedAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
        userAgent: null,
        ip: null,
      },
      {
        userId: user.id,
        familyId: randomUUID(),
        tokenHash: randomUUID(),
        expiresAt: new Date(now + 60_000),
        revokedAt: new Date(now - 60_000),
        userAgent: null,
        ip: null,
      },
      {
        userId: user.id,
        familyId: randomUUID(),
        tokenHash: randomUUID(),
        expiresAt: new Date(now + 60_000),
        revokedAt: null,
        userAgent: null,
        ip: null,
      },
    ]
    await prisma.session.createMany({ data: sessions })

    expect(await cleanupSessions({ prisma })).toBe(501)
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2)
    expect(await cleanupSessions({ prisma })).toBe(0)
  }, 20_000)

  it('reconciles unread counts in batches using message status semantics', async () => {
    const users = Array.from({ length: 501 }, () => {
      const id = randomUUID()
      const suffix = id.replaceAll('-', '')
      return {
        id,
        username: `worker_${suffix}`,
        email: `worker_${suffix}@example.com`,
        passwordHash: 'worker-test-hash',
        displayName: 'Worker test user',
      }
    })
    await prisma.user.createMany({ data: users })
    createdUserIds.push(...users.map(({ id }) => id))

    const owner = users[0]
    if (!owner) {
      throw new Error('Unread reconciliation fixture has no owner')
    }
    const conversation = await prisma.conversation.create({
      data: {
        type: 'GROUP',
        name: `Worker unread ${randomUUID()}`,
        createdById: owner.id,
        lastSeq: 1,
      },
      select: { id: true },
    })
    createdConversationIds.push(conversation.id)
    await prisma.participant.createMany({
      data: users.map(({ id }, index) => ({
        conversationId: conversation.id,
        userId: id,
        role: index === 0 ? 'OWNER' : 'MEMBER',
        unreadCount: 999,
      })),
    })
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        seq: 1,
        senderId: owner.id,
        content: 'reconciliation fixture',
        clientMessageId: randomUUID(),
      },
    })

    expect(await reconcileUnread({ logger, prisma })).toBe(501)
    expect(
      await prisma.participant.count({
        where: { conversationId: conversation.id, unreadCount: 1 },
      }),
    ).toBe(500)
    expect(
      await prisma.participant.findUniqueOrThrow({
        where: {
          conversationId_userId: { conversationId: conversation.id, userId: owner.id },
        },
      }),
    ).toMatchObject({ unreadCount: 0 })
    expect(await reconcileUnread({ logger, prisma })).toBe(0)
  }, 30_000)

  it('sweeps stale presence and emits the offline event to conversation rooms', async () => {
    const watcher = await createUser()
    const staleUser = await createUser()
    const liveUser = await createUser()
    const conversation = await prisma.conversation.create({
      data: {
        type: 'GROUP',
        name: `Worker presence ${randomUUID()}`,
        createdById: watcher.id,
        participants: {
          create: [
            { userId: watcher.id, role: 'OWNER' },
            { userId: staleUser.id, role: 'MEMBER' },
            { userId: liveUser.id, role: 'MEMBER' },
          ],
        },
      },
      select: { id: true },
    })
    createdConversationIds.push(conversation.id)

    const expiredAt = Date.now() - 60_000
    await redis.zadd(`presence:${staleUser.id}`, expiredAt, 'stale-socket')
    await redis.sadd('presence:active', staleUser.id)
    await redis.zadd(`presence:${liveUser.id}`, Date.now() + 60_000, 'live-socket')
    await redis.sadd('presence:active', liveUser.id)

    const httpServer = createServer()
    const publisher = redis.duplicate()
    const subscriber = redis.duplicate()
    const emitterRedis = redis.duplicate()
    const io = new Server<DefaultEventsMap, ServerToClientEvents>(httpServer, {
      transports: ['websocket'],
    })
    io.adapter(createAdapter(publisher, subscriber))

    let client: ReturnType<typeof createSocketClient> | undefined
    try {
      await Promise.all([publisher.ping(), subscriber.ping(), emitterRedis.ping()])
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
      })
      const address = httpServer.address()
      if (!address || typeof address === 'string') {
        throw new Error('Presence sweep test server did not bind to a TCP port')
      }

      const room = `conv:${conversation.id}`
      const joined = new Promise<void>((resolve, reject) => {
        io.once('connection', (socket) => {
          void Promise.resolve(socket.join(room)).then(resolve, reject)
        })
      })
      client = createSocketClient(`http://127.0.0.1:${address.port}`, {
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
      })
      const connected = new Promise<void>((resolve, reject) => {
        client?.once('connect', resolve)
        client?.once('connect_error', reject)
        client?.connect()
      })
      await Promise.all([connected, joined])

      const offlineEvent = new Promise<PresenceUpdate>((resolve) => {
        client?.once('presence:update', resolve)
      })
      const emitter = new Emitter<ServerToClientEvents>(emitterRedis)
      expect(await sweepPresence({ emitter, prisma, redis })).toBe(1)
      const event = await offlineEvent

      expect(event).toMatchObject({
        userId: staleUser.id,
        online: false,
      })
      expect(Date.parse(event.lastSeenAt ?? '')).not.toBeNaN()
      expect(await redis.sismember('presence:active', staleUser.id)).toBe(0)
      expect(await redis.sismember('presence:active', liveUser.id)).toBe(1)
      expect(await redis.sismember('lastSeen:dirty', staleUser.id)).toBe(1)
    } finally {
      client?.disconnect()
      await io.close()
      await Promise.all([
        closeRedisConnection(emitterRedis),
        closeRedisConnection(publisher),
        closeRedisConnection(subscriber),
      ])
    }
  }, 20_000)
})

async function closeRedisConnection(connection: Redis): Promise<void> {
  if (connection.status !== 'end') {
    await connection.quit()
  }
}
