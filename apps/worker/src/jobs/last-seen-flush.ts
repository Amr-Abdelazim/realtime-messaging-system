import { Prisma } from '@prisma/client'
import type { Redis } from 'ioredis'
import type { PrismaClient } from '@prisma/client'

const DIRTY_USERS_KEY = 'lastSeen:dirty'
const LAST_SEEN_KEY_PREFIX = 'lastSeen:'
const BATCH_SIZE = 500

type LastSeenFlushDependencies = {
  prisma: PrismaClient
  redis: Redis
}

type LastSeenValue = {
  userId: string
  lastSeenAt: Date
}

export async function run({ prisma, redis }: LastSeenFlushDependencies): Promise<number> {
  let updatedCount = 0

  while (true) {
    const userIds = await redis.spop(DIRTY_USERS_KEY, BATCH_SIZE)
    if (userIds.length === 0) {
      return updatedCount
    }

    try {
      const timestamps = await redis.mget(
        ...userIds.map((userId) => `${LAST_SEEN_KEY_PREFIX}${userId}`),
      )
      if (timestamps.length !== userIds.length) {
        throw new Error('Redis returned an incomplete last-seen batch')
      }

      const values: LastSeenValue[] = []
      for (const [index, userId] of userIds.entries()) {
        const timestamp = timestamps[index]
        if (timestamp === null) {
          continue
        }
        if (!timestamp || !/^\d+$/.test(timestamp)) {
          throw new Error(`Redis returned an invalid last-seen timestamp for user ${userId}`)
        }

        const lastSeenAt = new Date(Number(timestamp))
        if (!Number.isFinite(lastSeenAt.getTime())) {
          throw new Error(`Redis returned an invalid last-seen timestamp for user ${userId}`)
        }
        values.push({ userId, lastSeenAt })
      }

      if (values.length > 0) {
        const rows = Prisma.join(
          values.map(
            ({ userId, lastSeenAt }) => Prisma.sql`(${userId}::text, ${lastSeenAt}::timestamptz)`,
          ),
        )
        updatedCount += await prisma.$executeRaw`
          UPDATE "User" AS users
          SET "lastSeenAt" = source_rows."lastSeenAt"
          FROM (VALUES ${rows}) AS source_rows(id, "lastSeenAt")
          WHERE users."id" = source_rows.id
        `
      }
    } catch (error) {
      try {
        await redis.sadd(DIRTY_USERS_KEY, ...userIds)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Last-seen batch failed and its dirty users could not be restored',
          { cause: restoreError },
        )
      }
      throw error
    }
  }
}
