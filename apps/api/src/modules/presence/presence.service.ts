import { randomUUID } from 'node:crypto'

import { logger } from '../../infra/logger.js'
import { redis } from '../../infra/redis.js'

const ACTIVE_USERS_KEY = 'presence:active'
const LAST_SEEN_DIRTY_KEY = 'lastSeen:dirty'
const LAST_SEEN_TTL_SECONDS = 7 * 24 * 60 * 60
const HEARTBEAT_TTL_MS = 60_000

const ADD_SOCKET_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local liveCount = redis.call('ZCARD', KEYS[1])
local isActive = redis.call('SISMEMBER', KEYS[2], ARGV[4])
local pending = redis.call('EXISTS', KEYS[3])
local becameOnline = 0
if isActive == 0 or (liveCount == 0 and pending == 0) then
  becameOnline = 1
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('DEL', KEYS[3])
return becameOnline
`

const REMOVE_SOCKET_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) > 0 then
  return 0
end
if redis.call('SISMEMBER', KEYS[2], ARGV[3]) == 0 then
  return 0
end
if redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[5], 'NX') then
  return 1
end
return 0
`

const FINALIZE_DISCONNECT_SCRIPT = `
if redis.call('GET', KEYS[3]) ~= ARGV[1] then
  return 0
end
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) > 0 then
  redis.call('DEL', KEYS[3])
  return 0
end
if redis.call('SISMEMBER', KEYS[2], ARGV[3]) == 0 then
  redis.call('DEL', KEYS[3])
  return 0
end
redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[4])
redis.call('SADD', KEYS[5], ARGV[3])
redis.call('SREM', KEYS[2], ARGV[3])
redis.call('DEL', KEYS[3])
return 1
`

export type PresenceValue = {
  online: boolean
  lastSeenAt: string | null
}

export type PresenceChangeHandler = (userId: string, lastSeenAt: string) => void | Promise<void>

export class PresenceService {
  constructor(
    private readonly onOffline?: PresenceChangeHandler,
    private readonly debounceMs = 5_000,
  ) {}

  async connect(userId: string, socketId: string): Promise<boolean> {
    return this.addSocket(userId, socketId)
  }

  async heartbeat(userId: string, socketId: string): Promise<boolean> {
    return this.addSocket(userId, socketId)
  }

  async disconnect(userId: string, socketId: string): Promise<void> {
    const now = Date.now()
    const token = `${socketId}:${now}:${randomUUID()}`
    const result = await redis.eval(
      REMOVE_SOCKET_SCRIPT,
      3,
      `presence:${userId}`,
      ACTIVE_USERS_KEY,
      `presence:pending-offline:${userId}`,
      socketId,
      String(now),
      userId,
      token,
      String(this.debounceMs + 1_000),
    )
    if (Number(result) !== 1) {
      return
    }

    setTimeout(() => {
      void this.finalizeDisconnect(userId, token).catch((error: unknown) => {
        logger.error({ err: error, userId }, 'Failed to finalize presence disconnect')
      })
    }, this.debounceMs)
  }

  async getPresence(userIds: string[]): Promise<Map<string, PresenceValue>> {
    const uniqueIds = [...new Set(userIds)]
    const presenceByUser = new Map<string, PresenceValue>()
    if (uniqueIds.length === 0) {
      return presenceByUser
    }

    const now = Date.now()
    const pipeline = redis.pipeline()
    for (const userId of uniqueIds) {
      const key = `presence:${userId}`
      pipeline.zremrangebyscore(key, '-inf', String(now))
      pipeline.zcard(key)
      pipeline.get(`lastSeen:${userId}`)
    }
    const results = await pipeline.exec()
    if (!results) {
      throw new Error('Presence Redis pipeline returned no results')
    }

    for (const [index, userId] of uniqueIds.entries()) {
      const offset = index * 3
      const cleanup = results[offset]
      const count = results[offset + 1]
      const lastSeen = results[offset + 2]
      if (!cleanup || !count || !lastSeen) {
        throw new Error('Presence Redis pipeline returned an incomplete result')
      }
      if (cleanup[0]) {
        throw cleanup[0]
      }
      if (count[0]) {
        throw count[0]
      }
      if (lastSeen[0]) {
        throw lastSeen[0]
      }

      const liveSocketCount = Number(count[1])
      if (!Number.isSafeInteger(liveSocketCount) || liveSocketCount < 0) {
        throw new Error('Presence Redis pipeline returned an invalid socket count')
      }
      const online = liveSocketCount > 0
      presenceByUser.set(userId, {
        online,
        lastSeenAt: online ? null : toIsoDate(lastSeen[1]),
      })
    }

    return presenceByUser
  }

  private async addSocket(userId: string, socketId: string): Promise<boolean> {
    const now = Date.now()
    const result = await redis.eval(
      ADD_SOCKET_SCRIPT,
      3,
      `presence:${userId}`,
      ACTIVE_USERS_KEY,
      `presence:pending-offline:${userId}`,
      String(now),
      String(now + HEARTBEAT_TTL_MS),
      socketId,
      userId,
    )
    return Number(result) === 1
  }

  private async finalizeDisconnect(userId: string, token: string): Promise<void> {
    const lastSeenAtMs = Date.now()
    const result = await redis.eval(
      FINALIZE_DISCONNECT_SCRIPT,
      5,
      `presence:${userId}`,
      ACTIVE_USERS_KEY,
      `presence:pending-offline:${userId}`,
      `lastSeen:${userId}`,
      LAST_SEEN_DIRTY_KEY,
      token,
      String(lastSeenAtMs),
      userId,
      String(LAST_SEEN_TTL_SECONDS),
    )
    if (Number(result) === 1) {
      if (!this.onOffline) {
        throw new Error('An offline presence handler is required to broadcast transitions')
      }
      await this.onOffline(userId, new Date(lastSeenAtMs).toISOString())
    }
  }
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('Presence Redis last-seen value is invalid')
  }

  const date = new Date(Number(value))
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Presence Redis last-seen value is invalid')
  }
  return date.toISOString()
}
