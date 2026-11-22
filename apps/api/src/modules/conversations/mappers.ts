import {
  ConversationDto,
  ConversationReceipts,
  type ConversationReceipts as ConversationReceiptsType,
} from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'

import {
  messageWithReplyInclude,
  toMessageDto,
  type MessageWithReply,
} from '../messages/mappers.js'

export const conversationInclude = {
  participants: {
    where: { leftAt: null },
    orderBy: { userId: 'asc' },
    select: {
      userId: true,
      role: true,
      unreadCount: true,
      lastReadSeq: true,
      lastDeliveredSeq: true,
      user: {
        select: {
          displayName: true,
          avatarUrl: true,
          lastSeenAt: true,
        },
      },
    },
  },
  lastMessage: { include: messageWithReplyInclude },
} satisfies Prisma.ConversationInclude

export const conversationListSelect = {
  id: true,
  type: true,
  name: true,
  lastSeq: true,
  lastMessageAt: true,
  lastMessage: { include: messageWithReplyInclude },
  participants: {
    where: { leftAt: null },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    take: 5,
    select: {
      userId: true,
      role: true,
      unreadCount: true,
      lastReadSeq: true,
      lastDeliveredSeq: true,
      user: {
        select: {
          displayName: true,
          avatarUrl: true,
          lastSeenAt: true,
        },
      },
    },
  },
  _count: {
    select: {
      participants: { where: { leftAt: null } },
    },
  },
} satisfies Prisma.ConversationSelect

export type ConversationWithRelations = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude
}>

export type ConversationListRow = Prisma.ConversationGetPayload<{
  select: typeof conversationListSelect
}>

type ConversationMember = ConversationWithRelations['participants'][number]
type ConversationSummary = Pick<ConversationWithRelations, 'id' | 'type' | 'name' | 'lastSeq'> & {
  lastMessage: MessageWithReply | null
}

function mapConversationDto(
  row: ConversationSummary,
  participants: ConversationMember[],
  memberCount: number,
  viewer: { unreadCount: number; lastReadSeq: number },
  receipts: ConversationReceiptsType,
  peerPresence: ConversationDto['peerPresence'],
) {
  return ConversationDto.parse({
    id: row.id,
    type: row.type,
    name: row.name,
    members: participants.map((participant) => ({
      userId: participant.userId,
      role: participant.role,
      displayName: participant.user.displayName,
      avatarUrl: participant.user.avatarUrl,
    })),
    lastSeq: row.lastSeq,
    memberCount,
    lastMessage: row.lastMessage ? toMessageDto(row.lastMessage) : null,
    unreadCount: viewer.unreadCount,
    myLastReadSeq: viewer.lastReadSeq,
    receipts,
    peerPresence,
  })
}

function getReceipts(
  participants: ConversationMember[],
  viewerId: string,
): ConversationReceiptsType {
  const peers = participants.filter((participant) => participant.userId !== viewerId)
  return ConversationReceipts.parse({
    deliveredUpTo:
      peers.length > 0 ? Math.min(...peers.map(({ lastDeliveredSeq }) => lastDeliveredSeq)) : 0,
    readUpTo: peers.length > 0 ? Math.min(...peers.map(({ lastReadSeq }) => lastReadSeq)) : 0,
  })
}

export function toConversationDto(
  row: ConversationWithRelations,
  viewerId: string,
  peerPresence: ConversationDto['peerPresence'] = null,
) {
  const viewer = row.participants.find((participant) => participant.userId === viewerId)
  if (!viewer) {
    throw new Error('Cannot map a conversation for a non-member')
  }

  return mapConversationDto(
    row,
    row.participants,
    row.participants.length,
    viewer,
    getReceipts(row.participants, viewerId),
    peerPresence,
  )
}

export function toConversationListDto(
  row: ConversationListRow,
  viewerId: string,
  viewer: { unreadCount: number; lastReadSeq: number },
  receipts: ConversationReceiptsType,
  peerPresence: ConversationDto['peerPresence'] = null,
) {
  const members =
    row.type === 'DIRECT'
      ? row.participants.filter((participant) => participant.userId !== viewerId)
      : row.participants
  return mapConversationDto(row, members, row._count.participants, viewer, receipts, peerPresence)
}
