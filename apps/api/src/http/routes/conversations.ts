import {
  AddConversationMembersBody,
  CreateConversationBody,
  UpdateConversationBody,
} from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'

import { NotFoundError, UnauthenticatedError, ValidationError } from '../errors/index.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validate } from '../middleware/validate.js'
import { prisma } from '../../infra/prisma.js'
import { ConversationsService } from '../../modules/conversations/conversations.service.js'
import { conversationInclude, toConversationDto } from '../../modules/conversations/mappers.js'
import { NoopGateway, type RealtimeGateway } from '../../realtime/gateway.js'

export function createConversationsRouter(
  gateway: RealtimeGateway = new NoopGateway(),
): ExpressRouter {
  const router: ExpressRouter = Router()
  const conversations = new ConversationsService(gateway)

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
