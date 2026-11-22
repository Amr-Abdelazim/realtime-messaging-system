import { CreateConversationBody } from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'

import { NotFoundError, UnauthenticatedError, ValidationError } from '../errors/index.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validate } from '../middleware/validate.js'
import { prisma } from '../../infra/prisma.js'
import { conversationInclude, toConversationDto } from '../../modules/conversations/mappers.js'

const router: ExpressRouter = Router()

const createConversationHandler: RequestHandler = async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError()
  }

  const userId = req.auth.userId
  const body = CreateConversationBody.parse(req.body)
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

export default router
