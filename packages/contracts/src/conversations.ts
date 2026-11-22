import { z } from 'zod'

import { IdSchema, IsoDateSchema } from './common.js'
import { ConversationReceipts } from './status.js'

const DirectCreateConversationBody = z.object({
  type: z.literal('DIRECT'),
  userId: IdSchema,
})

const GroupCreateConversationBody = z.object({
  type: z.literal('GROUP'),
  name: z.string().trim().min(1).max(100),
  memberIds: z.array(IdSchema),
})

export const CreateConversationBody = z.discriminatedUnion('type', [
  DirectCreateConversationBody,
  GroupCreateConversationBody,
])

export type CreateConversationBody = z.infer<typeof CreateConversationBody>

export const UpdateConversationBody = z.object({
  name: z.string().trim().min(1).max(100),
})

export type UpdateConversationBody = z.infer<typeof UpdateConversationBody>

export const ConversationReadBody = z.object({
  upToSeq: z.number().int().nonnegative(),
})

export type ConversationReadBody = z.infer<typeof ConversationReadBody>

export const AddConversationMembersBody = z.object({
  userIds: z.array(IdSchema).min(1),
})

export type AddConversationMembersBody = z.infer<typeof AddConversationMembersBody>

export const ConversationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().min(1).optional(),
})

export type ConversationListQuery = z.infer<typeof ConversationListQuery>

export const MessageHistoryQuery = z
  .object({
    beforeSeq: z.coerce.number().int().nonnegative().optional(),
    afterSeq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((query) => query.beforeSeq === undefined || query.afterSeq === undefined, {
    message: 'beforeSeq and afterSeq cannot be used together',
    path: ['afterSeq'],
  })

export type MessageHistoryQuery = z.infer<typeof MessageHistoryQuery>

export const MessageDto = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  seq: z.number().int(),
  senderId: IdSchema.nullable(),
  type: z.enum(['TEXT', 'SYSTEM']),
  content: z.string().nullable(),
  clientMessageId: z.string().uuid(),
  replyTo: z
    .object({
      id: IdSchema,
      senderId: IdSchema.nullable(),
      preview: z.string().nullable(),
    })
    .nullable(),
  createdAt: IsoDateSchema,
  deletedAt: IsoDateSchema.nullable(),
})

export type MessageDto = z.infer<typeof MessageDto>

export const MessageHistoryResponse = z.object({
  items: z.array(MessageDto),
  hasMore: z.boolean(),
})

export type MessageHistoryResponse = z.infer<typeof MessageHistoryResponse>

export const ConversationDto = z.object({
  id: IdSchema,
  type: z.enum(['DIRECT', 'GROUP']),
  name: z.string().nullable(),
  members: z.array(
    z.object({
      userId: IdSchema,
      role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
    }),
  ),
  lastSeq: z.number().int(),
  memberCount: z.number().int().nonnegative(),
  lastMessage: MessageDto.nullable(),
  unreadCount: z.number().int(),
  myLastReadSeq: z.number().int(),
  receipts: ConversationReceipts,
  peerPresence: z
    .object({
      online: z.boolean(),
      lastSeenAt: IsoDateSchema.nullable(),
    })
    .nullable(),
})

export type ConversationDto = z.infer<typeof ConversationDto>

export const ConversationListResponse = z.object({
  items: z.array(ConversationDto),
  nextCursor: z.string().nullable(),
})

export type ConversationListResponse = z.infer<typeof ConversationListResponse>
