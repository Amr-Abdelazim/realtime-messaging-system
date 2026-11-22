import { ForbiddenError, NotFoundError, ValidationError } from '../../http/errors/index.js'
import { prisma } from '../../infra/prisma.js'

type LockedConversation = { id: string; lastSeq: number }
type LockedParticipant = {
  leftAt: Date | null
  lastDeliveredSeq: number
  lastReadSeq: number
}
type UpdatedParticipant = { unreadCount: number }

export class MessageStatusService {
  async markDelivered(userId: string, conversationId: string, upToSeq: number) {
    return prisma.$transaction(async (tx) => {
      const conversations = await tx.$queryRaw<LockedConversation[]>`
        SELECT "id", "lastSeq" FROM "Conversation" WHERE "id" = ${conversationId} FOR UPDATE
      `
      const conversation = conversations[0]
      if (!conversation) {
        throw new NotFoundError('Conversation not found')
      }
      const participants = await tx.$queryRaw<LockedParticipant[]>`
        SELECT "leftAt", "lastDeliveredSeq", "lastReadSeq"
        FROM "Participant"
        WHERE "conversationId" = ${conversationId} AND "userId" = ${userId}
        FOR UPDATE
      `
      const participant = participants[0]
      if (!participant || participant.leftAt) {
        throw new ForbiddenError()
      }
      if (upToSeq > conversation.lastSeq) {
        throw new ValidationError('upToSeq cannot exceed the conversation lastSeq')
      }

      const advanced = upToSeq > participant.lastDeliveredSeq
      if (advanced) {
        await tx.$executeRaw`
          UPDATE "Participant"
          SET "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${upToSeq})
          WHERE "conversationId" = ${conversationId}
            AND "userId" = ${userId}
            AND "leftAt" IS NULL
        `
      }
      return { advanced, upToSeq }
    })
  }

  async markRead(userId: string, conversationId: string, upToSeq: number) {
    return prisma.$transaction(async (tx) => {
      const conversations = await tx.$queryRaw<LockedConversation[]>`
        SELECT "id", "lastSeq" FROM "Conversation" WHERE "id" = ${conversationId} FOR UPDATE
      `
      const conversation = conversations[0]
      if (!conversation) {
        throw new NotFoundError('Conversation not found')
      }
      const participants = await tx.$queryRaw<LockedParticipant[]>`
        SELECT "leftAt", "lastDeliveredSeq", "lastReadSeq"
        FROM "Participant"
        WHERE "conversationId" = ${conversationId} AND "userId" = ${userId}
        FOR UPDATE
      `
      const participant = participants[0]
      if (!participant || participant.leftAt) {
        throw new ForbiddenError()
      }
      if (upToSeq > conversation.lastSeq) {
        throw new ValidationError('upToSeq cannot exceed the conversation lastSeq')
      }

      const effectiveReadSeq = Math.max(upToSeq, participant.lastReadSeq)
      const updated = await tx.$queryRaw<UpdatedParticipant[]>`
        UPDATE "Participant"
        SET "lastReadSeq" = GREATEST("lastReadSeq", ${upToSeq}),
            "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${effectiveReadSeq}),
            "unreadCount" = (
              SELECT COUNT(*)::integer
              FROM "Message"
              WHERE "conversationId" = ${conversationId}
                AND "seq" > ${effectiveReadSeq}
                AND "senderId" IS DISTINCT FROM ${userId}
                AND "deletedAt" IS NULL
            )
        WHERE "conversationId" = ${conversationId}
          AND "userId" = ${userId}
          AND "leftAt" IS NULL
        RETURNING "unreadCount"
      `
      const result = updated[0]
      if (!result) {
        throw new ForbiddenError()
      }

      return {
        advanced: upToSeq > participant.lastReadSeq,
        upToSeq: effectiveReadSeq,
        unreadCount: result.unreadCount,
      }
    })
  }
}
