import { Prisma, type PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'

const BATCH_SIZE = 500

type UnreadReconcileDependencies = {
  logger: Logger
  prisma: PrismaClient
}

type ParticipantCursor = {
  conversationId: string
  userId: string
}

export async function run({ logger, prisma }: UnreadReconcileDependencies): Promise<number> {
  let cursor: ParticipantCursor | undefined
  let correctedRows = 0

  while (true) {
    const participants = await prisma.participant.findMany({
      ...(cursor
        ? {
            where: {
              OR: [
                { conversationId: { gt: cursor.conversationId } },
                { conversationId: cursor.conversationId, userId: { gt: cursor.userId } },
              ],
            },
          }
        : {}),
      orderBy: [{ conversationId: 'asc' }, { userId: 'asc' }],
      take: BATCH_SIZE,
      select: { conversationId: true, userId: true },
    })
    if (participants.length === 0) {
      break
    }

    const ids = Prisma.join(
      participants.map(
        ({ conversationId, userId }) =>
          Prisma.sql`(${conversationId}::text, ${userId}::text)`,
      ),
    )
    correctedRows += await prisma.$executeRaw`
      WITH requested("conversationId", "userId") AS (
        VALUES ${ids}
      ),
      expected AS (
        SELECT participants."conversationId",
               participants."userId",
               COUNT(messages."id")::integer AS "unreadCount"
        FROM requested
        JOIN "Participant" AS participants
          ON participants."conversationId" = requested."conversationId"
         AND participants."userId" = requested."userId"
        LEFT JOIN "Message" AS messages
          ON messages."conversationId" = participants."conversationId"
         AND messages."seq" > participants."lastReadSeq"
         AND messages."senderId" IS DISTINCT FROM participants."userId"
         AND messages."deletedAt" IS NULL
        GROUP BY participants."conversationId", participants."userId"
      )
      UPDATE "Participant" AS participants
      SET "unreadCount" = expected."unreadCount"
      FROM expected
      WHERE participants."conversationId" = expected."conversationId"
        AND participants."userId" = expected."userId"
        AND participants."unreadCount" <> expected."unreadCount"
    `

    const lastParticipant = participants.at(-1)
    if (!lastParticipant) {
      throw new Error('Unread reconciliation batch unexpectedly contained no participants')
    }
    cursor = lastParticipant
  }

  logger.info({ correctedRows }, 'Unread count reconciliation complete')
  return correctedRows
}
