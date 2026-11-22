import { MessageDto } from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'

export const messageWithReplyInclude = {
  replyTo: {
    select: {
      id: true,
      senderId: true,
      content: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.MessageInclude

export type MessageWithReply = Prisma.MessageGetPayload<{
  include: typeof messageWithReplyInclude
}>

export function toMessageDto(message: MessageWithReply) {
  return MessageDto.parse({
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    senderId: message.senderId,
    type: message.type,
    content: message.deletedAt ? null : message.content,
    clientMessageId: message.clientMessageId,
    replyTo: message.replyTo
      ? {
          id: message.replyTo.id,
          senderId: message.replyTo.senderId,
          preview: message.replyTo.deletedAt ? null : message.replyTo.content.slice(0, 80),
        }
      : null,
    createdAt: message.createdAt.toISOString(),
    deletedAt: message.deletedAt?.toISOString() ?? null,
  })
}
