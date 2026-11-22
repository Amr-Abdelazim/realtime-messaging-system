import {
  AddConversationMembersBody,
  ConversationListQuery,
  ConversationListResponse,
  CreateConversationBody,
  IdSchema,
  IsoDateSchema,
  MessageHistoryQuery,
  MessageHistoryResponse,
  UpdateConversationBody,
} from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'
import { z } from 'zod'

import { NotFoundError, UnauthenticatedError, ValidationError } from '../errors/index.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validate } from '../middleware/validate.js'
import { prisma } from '../../infra/prisma.js'
import { ConversationsService } from '../../modules/conversations/conversations.service.js'
import {
  conversationInclude,
  conversationListSelect,
  toConversationDto,
  toConversationListDto,
} from '../../modules/conversations/mappers.js'
import { messageWithReplyInclude, toMessageDto } from '../../modules/messages/mappers.js'
import { NoopGateway, type RealtimeGateway } from '../../realtime/gateway.js'

export function createConversationsRouter(
  gateway: RealtimeGateway = new NoopGateway(),
): ExpressRouter {
  const router: ExpressRouter = Router()
  const conversations = new ConversationsService(gateway)

  const listHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }

    const userId = req.auth.userId
    const parsedQuery = ConversationListQuery.safeParse(req.query)
    if (!parsedQuery.success) {
      const details = parsedQuery.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'query',
        message: issue.message,
      }))
      throw new ValidationError('Invalid request', details)
    }

    const { limit, cursor: encodedCursor } = parsedQuery.data
    const cursor = encodedCursor ? decodeConversationCursor(encodedCursor) : undefined
    const rows = await prisma.participant.findMany({
      relationLoadStrategy: 'join',
      where: {
        userId,
        leftAt: null,
        conversation: {
          is: {
            lastMessageAt: { not: null },
            ...(cursor
              ? {
                  OR: [
                    { lastMessageAt: { lt: cursor.lastMessageAt } },
                    { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
        },
      },
      orderBy: [{ conversation: { lastMessageAt: 'desc' } }, { conversationId: 'desc' }],
      take: limit + 1,
      select: {
        unreadCount: true,
        lastReadSeq: true,
        conversation: { select: conversationListSelect },
      },
    })

    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map(({ conversation, unreadCount, lastReadSeq }) =>
      toConversationListDto(conversation, userId, { unreadCount, lastReadSeq }),
    )
    let nextCursor: string | null = null
    if (hasMore) {
      const lastRow = pageRows.at(-1)
      if (!lastRow) {
        throw new Error('Cannot encode a cursor for an empty page')
      }

      const lastMessageAt = lastRow.conversation.lastMessageAt
      if (!lastMessageAt) {
        throw new Error('Cannot encode a cursor for a conversation without lastMessageAt')
      }
      nextCursor = encodeConversationCursor(lastMessageAt, lastRow.conversation.id)
    }

    res.status(200).json(ConversationListResponse.parse({ items, nextCursor }))
  }

  router.get('/conversations', requireAuth, listHandler)

  const createConversationHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }

    const userId = req.auth.userId
    const body = CreateConversationBody.parse(req.body)
    if (body.type === 'GROUP') {
      const conversation = await conversations.createGroup(userId, body)
      res.status(201).json(conversation)
      return
    }

    if (body.userId === userId) {
      throw new ValidationError('Cannot create a conversation with yourself')
    }

    const directKey = [userId, body.userId].sort().join(':')

    try {
      const result = await prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: body.userId },
          select: { id: true },
        })
        if (!target) {
          throw new NotFoundError('User not found')
        }

        const existing = await tx.conversation.findUnique({
          where: { directKey },
          include: conversationInclude,
        })
        if (existing) {
          return { conversation: existing, created: false }
        }

        const conversation = await tx.conversation.create({
          data: {
            type: 'DIRECT',
            directKey,
            lastMessageAt: new Date(),
            createdBy: { connect: { id: userId } },
            participants: {
              create: [
                {
                  user: { connect: { id: userId } },
                  lastDeliveredSeq: 0,
                  lastReadSeq: 0,
                },
                {
                  user: { connect: { id: body.userId } },
                  lastDeliveredSeq: 0,
                  lastReadSeq: 0,
                },
              ],
            },
          },
          include: conversationInclude,
        })

        return { conversation, created: true }
      })

      res.status(result.created ? 201 : 200).json(toConversationDto(result.conversation, userId))
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }

      const existing = await prisma.conversation.findUnique({
        where: { directKey },
        include: conversationInclude,
      })
      if (!existing) {
        throw error
      }

      res.status(200).json(toConversationDto(existing, userId))
    }
  }

  router.post(
    '/conversations',
    requireAuth,
    validate({ body: CreateConversationBody }),
    createConversationHandler,
  )

  const listMessagesHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }

    const conversationId = req.params.id
    if (typeof conversationId !== 'string') {
      throw new NotFoundError('Conversation not found')
    }

    const parsedQuery = MessageHistoryQuery.safeParse(req.query)
    if (!parsedQuery.success) {
      const details = parsedQuery.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'query',
        message: issue.message,
      }))
      throw new ValidationError('Invalid request', details)
    }

    const participant = await prisma.participant.findFirst({
      where: {
        conversationId,
        userId: req.auth.userId,
        leftAt: null,
      },
      select: { joinedAtSeq: true },
    })
    if (!participant) {
      throw new NotFoundError('Conversation not found')
    }

    const { beforeSeq, afterSeq, limit } = parsedQuery.data
    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        seq: {
          gt:
            afterSeq === undefined
              ? participant.joinedAtSeq
              : Math.max(participant.joinedAtSeq, afterSeq),
          ...(beforeSeq === undefined ? {} : { lt: beforeSeq }),
        },
      },
      orderBy: { seq: afterSeq === undefined ? 'desc' : 'asc' },
      take: limit + 1,
      include: messageWithReplyInclude,
    })

    const pageRows = rows.slice(0, limit)
    res.status(200).json(
      MessageHistoryResponse.parse({
        items: pageRows.map(toMessageDto),
        hasMore: rows.length > limit,
      }),
    )
  }

  router.get('/conversations/:id/messages', requireAuth, listMessagesHandler)

  const getConversationHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }

    const conversationId = req.params.id
    if (typeof conversationId !== 'string') {
      throw new NotFoundError('Conversation not found')
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        participants: {
          some: {
            userId: req.auth.userId,
            leftAt: null,
          },
        },
      },
      include: conversationInclude,
    })
    if (!conversation) {
      throw new NotFoundError('Conversation not found')
    }

    res.status(200).json(toConversationDto(conversation, req.auth.userId))
  }

  router.get('/conversations/:id', requireAuth, getConversationHandler)

  const renameGroupHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    if (typeof req.params.id !== 'string') {
      throw new NotFoundError('Conversation not found')
    }

    const input = UpdateConversationBody.parse(req.body)
    const conversation = await conversations.renameGroup(req.auth.userId, req.params.id, input)
    res.status(200).json(conversation)
  }

  router.patch(
    '/conversations/:id',
    requireAuth,
    validate({ body: UpdateConversationBody }),
    renameGroupHandler,
  )

  const addMembersHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    if (typeof req.params.id !== 'string') {
      throw new NotFoundError('Conversation not found')
    }

    const input = AddConversationMembersBody.parse(req.body)
    const conversation = await conversations.addMembers(req.auth.userId, req.params.id, input)
    res.status(200).json(conversation)
  }

  router.post(
    '/conversations/:id/members',
    requireAuth,
    validate({ body: AddConversationMembersBody }),
    addMembersHandler,
  )

  const removeMemberHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    if (typeof req.params.id !== 'string' || typeof req.params.userId !== 'string') {
      throw new NotFoundError('Group member not found')
    }

    await conversations.removeMember(req.auth.userId, req.params.id, req.params.userId)
    res.status(204).end()
  }

  router.delete('/conversations/:id/members/:userId', requireAuth, removeMemberHandler)

  const leaveGroupHandler: RequestHandler = async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    if (typeof req.params.id !== 'string') {
      throw new NotFoundError('Conversation not found')
    }

    await conversations.leaveGroup(req.auth.userId, req.params.id)
    res.status(204).end()
  }

  router.post('/conversations/:id/leave', requireAuth, leaveGroupHandler)

  return router
}

const ConversationCursorPayload = z
  .object({
    lastMessageAt: IsoDateSchema,
    id: IdSchema,
  })
  .strict()

function decodeConversationCursor(cursor: string): { lastMessageAt: Date; id: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'Invalid base64url' }])
  }

  const decoded = Buffer.from(cursor, 'base64url')
  if (decoded.toString('base64url') !== cursor) {
    throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'Invalid base64url' }])
  }

  let value: unknown
  try {
    value = JSON.parse(decoded.toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'Invalid JSON' }])
    }
    throw error
  }

  const parsed = ConversationCursorPayload.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError(
      'Invalid cursor',
      parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `cursor.${issue.path.join('.')}` : 'cursor',
        message: issue.message,
      })),
    )
  }

  return { lastMessageAt: new Date(parsed.data.lastMessageAt), id: parsed.data.id }
}

function encodeConversationCursor(lastMessageAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ lastMessageAt: lastMessageAt.toISOString(), id })).toString(
    'base64url',
  )
}
