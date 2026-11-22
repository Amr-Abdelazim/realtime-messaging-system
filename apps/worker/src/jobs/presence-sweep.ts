import type { ServerToClientEvents } from '@realtime-messaging/contracts'
import type { PrismaClient } from '@prisma/client'
import type { Emitter } from '@socket.io/redis-emitter'
import type { Redis } from 'ioredis'

const ACTIVE_USERS_KEY = 'presence:active'
const LAST_SEEN_DIRTY_KEY = 'lastSeen:dirty'
const LAST_SEEN_TTL_SECONDS = 7 * 24 * 60 * 60
const SCAN_COUNT = 500

const SWEEP_USER_SCRIPT = `
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) > 0 then
  return 0
end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then
  return 0
end
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
redis.call('SADD', KEYS[4], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[5])
return 1
`

type PresenceSweepDependencies = {
  emitter: Emitter<ServerToClientEvents>
  prisma: PrismaClient
  redis: Redis
}

export async function run({ emitter, prisma, redis }: PresenceSweepDependencies): Promise<number> {
  let cursor = '0'
  let sweptUsers = 0

  do {
    const [nextCursor, userIds] = await redis.sscan(ACTIVE_USERS_KEY, cursor, 'COUNT', SCAN_COUNT)
    cursor = nextCursor

    for (const userId of userIds) {
      const conversations = await prisma.participant.findMany({
        where: { userId, leftAt: null },
        select: { conversationId: true },
      })
      const lastSeenAtMs = Date.now()
      const result = await redis.eval(
        SWEEP_USER_SCRIPT,
        5,
        `presence:${userId}`,
        ACTIVE_USERS_KEY,
        `lastSeen:${userId}`,
        LAST_SEEN_DIRTY_KEY,
        `presence:pending-offline:${userId}`,
        userId,
        String(lastSeenAtMs),
        String(LAST_SEEN_TTL_SECONDS),
      )
      if (Number(result) !== 1) {
        continue
      }

      sweptUsers += 1
      const payload = {
        userId,
        online: false,
        lastSeenAt: new Date(lastSeenAtMs).toISOString(),
      }
      for (const { conversationId } of conversations) {
        emitter.to(`conv:${conversationId}`).emit('presence:update', payload)
      }
    }
  } while (cursor !== '0')

  return sweptUsers
}
