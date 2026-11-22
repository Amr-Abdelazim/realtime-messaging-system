import { ConversationDto, MessageDto } from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'

export const conversationInclude = {
  participants: {
    where: { leftAt: null },
    orderBy: { userId: 'asc' },
    select: {
      userId: true,
      role: true,
      unreadCount: true,
      lastReadSeq: true,
      user: {
        select: {
          displayName: true,
          avatarUrl: true,
        },
      },
    },
  },
  lastMessage: {
    include: {
      replyTo: {
        select: {
          id: true,
          senderId: true,
          content: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.ConversationInclude

export type ConversationWithRelations = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude
}>

export function toConversationDto(row: ConversationWithRelations, viewerId: string) {
  const viewer = row.participants.find((participant) => participant.userId === viewerId)
  if (!viewer) {
    throw new Error('Cannot map a conversation for a non-member')
  }

  const lastMessage = row.lastMessage
    ? MessageDto.parse({
        id: row.lastMessage.id,
        conversationId: row.lastMessage.conversationId,
        seq: row.lastMessage.seq,
        senderId: row.lastMessage.senderId,
        type: row.lastMessage.type,
        content: row.lastMessage.deletedAt ? null : row.lastMessage.content,
        clientMessageId: row.lastMessage.clientMessageId,
        replyTo: row.lastMessage.replyTo
          ? {
              id: row.lastMessage.replyTo.id,
              senderId: row.lastMessage.replyTo.senderId,
              preview: row.lastMessage.replyTo.deletedAt
                ? 'Message deleted'
                : row.lastMessage.replyTo.content,
            }
          : null,
        createdAt: row.lastMessage.createdAt.toISOString(),
        deletedAt: row.lastMessage.deletedAt?.toISOString() ?? null,
      })
    : null

  return ConversationDto.parse({
    id: row.id,
    type: row.type,
    name: row.name,
    members: row.participants.map((participant) => ({
      userId: participant.userId,
      role: participant.role,
      displayName: participant.user.displayName,
      avatarUrl: participant.user.avatarUrl,
    })),
    lastSeq: row.lastSeq,
    lastMessage,
    unreadCount: viewer.unreadCount,
    myLastReadSeq: viewer.lastReadSeq,
    peerPresence: null,
  })
}
