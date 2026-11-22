import { redis } from './redis.js'

export type RateLimitPolicy = {
  limit: number
  windowSeconds: number
}

export type RateLimitResult = {
  allowed: boolean
  retryAfterSeconds: number
}

export async function rateLimit({
  key,
  limit,
  windowSeconds,
}: RateLimitPolicy & { key: string }): Promise<RateLimitResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Rate limit must be a positive integer')
  }
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new RangeError('Rate limit window must be a positive integer')
  }

  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, windowSeconds)
  }

  const ttl = await redis.ttl(key)
  return {
    allowed: count <= limit,
    retryAfterSeconds: Math.max(1, ttl),
  }
}
