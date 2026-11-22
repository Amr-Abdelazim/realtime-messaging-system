import { SendMessageAck, type SendMessageInput } from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'

import { ForbiddenError, NotFoundError, ValidationError } from '../../http/errors/index.js'
import { prisma } from '../../infra/prisma.js'
import { messageWithReplyInclude, toMessageDto } from './mappers.js'
import { allocateSeq } from './seq.js'

export class MessagesService {
  async deleteMessage(userId: string, messageId: string) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.message.findUnique({
        where: { id: messageId },
        select: { conversationId: true },
      })
      if (!current) {
        throw new NotFoundError('Message not found')
      }

      await tx.$queryRaw`
        SELECT "id" FROM "Conversation" WHERE "id" = ${current.conversationId} FOR UPDATE
      `

      const message = await tx.message.findUnique({
        where: { id: messageId },
        select: {
          conversationId: true,
          seq: true,
          senderId: true,
          type: true,
          deletedAt: true,
        },
      })
      if (!message) {
        throw new NotFoundError('Message not found')
      }
      if (message.type === 'SYSTEM') {
        throw new ValidationError('System messages cannot be deleted')
      }
      if (message.senderId !== userId) {
        throw new ForbiddenError()
      }
      if (message.deletedAt) {
        return {
          deleted: false,
          conversationId: message.conversationId,
          messageId,
          seq: message.seq,
        }
      }

      await tx.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date() },
      })
      await tx.participant.updateMany({
        where: {
          conversationId: message.conversationId,
          userId: { not: userId },
          leftAt: null,
          lastReadSeq: { lt: message.seq },
          unreadCount: { gt: 0 },
        },
        data: { unreadCount: { decrement: 1 } },
      })

      return {
        deleted: true,
        conversationId: message.conversationId,
        messageId,
        seq: message.seq,
      }
    })
  }

  async sendMessage(senderId: string, input: SendMessageInput): Promise<SendMessageAck> {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.message.findUnique({
          where: {
            senderId_clientMessageId: {
              senderId,
              clientMessageId: input.clientMessageId,
            },
          },
          include: messageWithReplyInclude,
        })
        if (existing) {
          return { message: existing, duplicate: true }
        }

        await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${input.conversationId} FOR UPDATE`

        const participant = await tx.participant.findUnique({
          where: {
            conversationId_userId: {
              conversationId: input.conversationId,
              userId: senderId,
            },
          },
          select: { leftAt: true },
        })
        if (!participant || participant.leftAt) {
          throw new ForbiddenError()
        }

        if (input.replyToId) {
          const replyTo = await tx.message.findUnique({
            where: { id: input.replyToId },
            select: { conversationId: true },
          })
          if (!replyTo || replyTo.conversationId !== input.conversationId) {
            throw new ValidationError('Reply target must belong to this conversation')
          }
        }

        const seq = await allocateSeq(tx, input.conversationId)
        const message = await tx.message.create({
          data: {
            conversationId: input.conversationId,
            seq,
            senderId,
            content: input.content,
            clientMessageId: input.clientMessageId,
            ...(input.replyToId ? { replyToId: input.replyToId } : {}),
          },
          include: messageWithReplyInclude,
        })
        await tx.conversation.update({
          where: { id: input.conversationId },
          data: { lastMessageId: message.id, lastMessageAt: message.createdAt },
        })
        await tx.participant.updateMany({
          where: {
            conversationId: input.conversationId,
            userId: { not: senderId },
            leftAt: null,
          },
          data: { unreadCount: { increment: 1 } },
        })
        await tx.participant.update({
          where: {
            conversationId_userId: {
              conversationId: input.conversationId,
              userId: senderId,
            },
          },
          data: { lastDeliveredSeq: seq, lastReadSeq: seq, unreadCount: 0 },
        })

        return { message, duplicate: false }
      })

      return SendMessageAck.parse({
        message: toMessageDto(result.message),
        duplicate: result.duplicate,
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }

      const existing = await prisma.message.findUnique({
        where: {
          senderId_clientMessageId: {
            senderId,
            clientMessageId: input.clientMessageId,
          },
        },
        include: messageWithReplyInclude,
      })
      if (!existing) {
        throw error
      }

      return SendMessageAck.parse({ message: toMessageDto(existing), duplicate: true })
    }
  }
}
