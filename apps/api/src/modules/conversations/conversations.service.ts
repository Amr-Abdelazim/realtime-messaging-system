import {
  type AddConversationMembersBody,
  type CreateConversationBody,
  type UpdateConversationBody,
} from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../http/errors/index.js'
import { prisma } from '../../infra/prisma.js'
import { NoopGateway, type RealtimeGateway } from '../../realtime/gateway.js'
import { createSystemMessage } from '../messages/seq.js'
import {
  conversationInclude,
  toConversationDto,
  type ConversationWithRelations,
} from './mappers.js'

type GroupCreateInput = Extract<CreateConversationBody, { type: 'GROUP' }>
type ActiveParticipant = ConversationWithRelations['participants'][number]

async function lockGroup(
  tx: Prisma.TransactionClient,
  conversationId: string,
  actorId: string,
): Promise<{ conversation: ConversationWithRelations; actor: ActiveParticipant }> {
  await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${conversationId} FOR UPDATE`

  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId },
    include: conversationInclude,
  })
  if (!conversation) {
    throw new NotFoundError('Conversation not found')
  }
  if (conversation.type !== 'GROUP') {
    throw new ValidationError('This operation is only available for group conversations')
  }

  const actor = conversation.participants.find((participant) => participant.userId === actorId)
  if (!actor) {
    throw new NotFoundError('Conversation not found')
  }

  return { conversation, actor }
}

function requireAdmin(actor: ActiveParticipant): void {
  if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
    throw new ForbiddenError()
  }
}

async function findOwnerSuccessor(
  tx: Prisma.TransactionClient,
  conversationId: string,
  leavingUserId: string,
): Promise<{ userId: string } | null> {
  const where = {
    conversationId,
    userId: { not: leavingUserId },
    leftAt: null,
  }
  const oldestAdmin = await tx.participant.findFirst({
    where: { ...where, role: 'ADMIN' },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true },
  })
  if (oldestAdmin) {
    return oldestAdmin
  }

  return tx.participant.findFirst({
    where: { ...where, role: 'MEMBER' },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true },
  })
}

export class ConversationsService {
  constructor(private readonly gateway: RealtimeGateway = new NoopGateway()) {}

  async createGroup(creatorId: string, input: GroupCreateInput) {
    const memberIds = [...new Set(input.memberIds)].filter((id) => id !== creatorId)
    if (memberIds.length < 1 || memberIds.length > 255) {
      throw new ValidationError('A group must have between 1 and 255 other members')
    }

    const conversation = await prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({
        where: { id: { in: [creatorId, ...memberIds] } },
        select: { id: true, displayName: true },
      })
      if (users.length !== memberIds.length + 1) {
        throw new NotFoundError('One or more users were not found')
      }

      const creator = users.find((user) => user.id === creatorId)
      if (!creator) {
        throw new NotFoundError('User not found')
      }

      const created = await tx.conversation.create({
        data: {
          type: 'GROUP',
          name: input.name,
          createdBy: { connect: { id: creatorId } },
          participants: {
            create: [
              {
                user: { connect: { id: creatorId } },
                role: 'OWNER',
                joinedAtSeq: 0,
              },
              ...memberIds.map((userId) => ({
                user: { connect: { id: userId } },
                role: 'MEMBER' as const,
                joinedAtSeq: 0,
              })),
            ],
          },
        },
        include: conversationInclude,
      })

      await createSystemMessage(tx, created.id, `${creator.displayName} created the group`, {
        action: 'created',
        actorId: creatorId,
        memberIds,
      })

      return tx.conversation.findUniqueOrThrow({
        where: { id: created.id },
        include: conversationInclude,
      })
    })

    await Promise.all(
      conversation.participants.map(async (participant) => {
        await this.gateway.joinUserToConversation(participant.userId, conversation.id)
        this.gateway.toUser(participant.userId, 'conversation:created', {
          conversation: toConversationDto(conversation, participant.userId),
        })
      }),
    )

    return toConversationDto(conversation, creatorId)
  }

  async renameGroup(actorId: string, conversationId: string, input: UpdateConversationBody) {
    const conversation = await prisma.$transaction(async (tx) => {
      const { conversation: current, actor } = await lockGroup(tx, conversationId, actorId)
      requireAdmin(actor)

      await tx.conversation.update({
        where: { id: current.id },
        data: { name: input.name },
      })
      await createSystemMessage(tx, current.id, `${actor.user.displayName} renamed the group`, {
        action: 'renamed',
        actorId,
        name: input.name,
      })

      return tx.conversation.findUniqueOrThrow({
        where: { id: current.id },
        include: conversationInclude,
      })
    })

    const dto = toConversationDto(conversation, actorId)
    this.gateway.toConversation(conversationId, 'conversation:updated', { conversation: dto })
    return dto
  }

  async addMembers(actorId: string, conversationId: string, input: AddConversationMembersBody) {
    const result = await prisma.$transaction(async (tx) => {
      const { conversation, actor } = await lockGroup(tx, conversationId, actorId)
      requireAdmin(actor)

      const requestedIds = [...new Set(input.userIds)].filter((id) => id !== actorId)
      const users = requestedIds.length
        ? await tx.user.findMany({
            where: { id: { in: requestedIds } },
            select: { id: true, displayName: true },
          })
        : []
      if (users.length !== requestedIds.length) {
        throw new NotFoundError('One or more users were not found')
      }

      const activeIds = new Set(conversation.participants.map((participant) => participant.userId))
      const addedIds = requestedIds.filter((id) => !activeIds.has(id))
      if (conversation.participants.length + addedIds.length > 256) {
        throw new ConflictError('A group cannot have more than 256 active members')
      }
      if (addedIds.length === 0) {
        return { conversation, addedIds }
      }

      const existingParticipants = await tx.participant.findMany({
        where: { conversationId, userId: { in: addedIds } },
        select: { userId: true },
      })
      const existingIds = new Set(existingParticipants.map((participant) => participant.userId))
      const rejoiningIds = addedIds.filter((id) => existingIds.has(id))
      const newIds = addedIds.filter((id) => !existingIds.has(id))
      const joinedAtSeq = conversation.lastSeq
      const joinedAt = new Date()

      if (newIds.length > 0) {
        await tx.participant.createMany({
          data: newIds.map((userId) => ({
            conversationId,
            userId,
            role: 'MEMBER',
            joinedAtSeq,
            lastDeliveredSeq: joinedAtSeq,
            lastReadSeq: joinedAtSeq,
          })),
        })
      }
      if (rejoiningIds.length > 0) {
        await tx.participant.updateMany({
          where: {
            conversationId,
            userId: { in: rejoiningIds },
            leftAt: { not: null },
          },
          data: {
            leftAt: null,
            joinedAt,
            joinedAtSeq,
            lastDeliveredSeq: joinedAtSeq,
            lastReadSeq: joinedAtSeq,
            unreadCount: 0,
          },
        })
      }

      const displayNames = new Map(users.map((user) => [user.id, user.displayName]))
      const addedNames = addedIds.map((id) => displayNames.get(id))
      if (addedNames.some((name) => name === undefined)) {
        throw new Error('Added user display names were not loaded')
      }
      const addedText = addedNames.length === 1 ? addedNames[0] : `${addedNames.length} members`
      await createSystemMessage(
        tx,
        conversationId,
        `${actor.user.displayName} added ${addedText}`,
        { action: 'members_added', actorId, userIds: addedIds },
      )

      const updated = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        include: conversationInclude,
      })
      return { conversation: updated, addedIds }
    })

    if (result.addedIds.length > 0) {
      await Promise.all(
        result.addedIds.map((userId) =>
          this.gateway.joinUserToConversation(userId, conversationId),
        ),
      )
      this.gateway.toConversation(conversationId, 'conversation:updated', {
        conversation: toConversationDto(result.conversation, actorId),
      })
    }

    return toConversationDto(result.conversation, actorId)
  }

  async removeMember(actorId: string, conversationId: string, targetId: string) {
    const conversation = await prisma.$transaction(async (tx) => {
      const { conversation: current, actor } = await lockGroup(tx, conversationId, actorId)
      const target = current.participants.find((participant) => participant.userId === targetId)
      if (!target) {
        throw new NotFoundError('Group member not found')
      }

      const removingSelf = actorId === targetId
      if (!removingSelf) {
        requireAdmin(actor)
        if (target.role === 'OWNER' || (target.role === 'ADMIN' && actor.role !== 'OWNER')) {
          throw new ForbiddenError()
        }
      }

      if (target.role === 'OWNER') {
        const successor = await findOwnerSuccessor(tx, conversationId, targetId)
        if (!successor) {
          throw new ConflictError('The owner cannot leave without another active member')
        }
        await tx.participant.update({
          where: { conversationId_userId: { conversationId, userId: successor.userId } },
          data: { role: 'OWNER' },
        })
      }

      await tx.participant.update({
        where: { conversationId_userId: { conversationId, userId: targetId } },
        data: {
          leftAt: new Date(),
          ...(target.role === 'OWNER' ? { role: 'MEMBER' } : {}),
        },
      })
      const text = removingSelf
        ? `${target.user.displayName} left the group`
        : `${actor.user.displayName} removed ${target.user.displayName}`
      await createSystemMessage(tx, conversationId, text, {
        action: removingSelf ? 'member_left' : 'member_removed',
        actorId,
        targetUserId: targetId,
      })

      return tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        include: conversationInclude,
      })
    })

    await this.gateway.removeUserFromConversation(targetId, conversationId)
    this.gateway.toUser(targetId, 'conversation:removed', { conversationId })
    const viewerId =
      conversation.participants.find((participant) => participant.userId === actorId)?.userId ??
      conversation.participants[0]?.userId
    if (viewerId) {
      this.gateway.toConversation(conversationId, 'conversation:updated', {
        conversation: toConversationDto(conversation, viewerId),
      })
    }
  }

  async leaveGroup(actorId: string, conversationId: string): Promise<void> {
    await this.removeMember(actorId, conversationId, actorId)
  }
}
