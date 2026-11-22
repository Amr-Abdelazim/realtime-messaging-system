import { MeDto, UpdateProfileBody, UserDto, UserSearchQuery } from '@realtime-messaging/contracts'
import { Prisma } from '@prisma/client'
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'

import { NotFoundError, UnauthenticatedError, ValidationError } from '../errors/index.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validate } from '../middleware/validate.js'
import { prisma } from '../../infra/prisma.js'

const router: ExpressRouter = Router()

const meHandler: RequestHandler = async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError()
  }

  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: {
      id: true,
      email: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      createdAt: true,
    },
  })

  if (!user) {
    throw new UnauthenticatedError()
  }

  res.status(200).json(MeDto.parse({ ...user, createdAt: user.createdAt.toISOString() }))
}

router.get('/users/me', requireAuth, meHandler)

const updateMeHandler: RequestHandler = async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError()
  }

  const body = UpdateProfileBody.parse(req.body)
  let user

  try {
    user = await prisma.user.update({
      where: { id: req.auth.userId },
      data: body,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new UnauthenticatedError()
    }

    throw error
  }

  res.status(200).json(MeDto.parse({ ...user, createdAt: user.createdAt.toISOString() }))
}

router.patch(
  '/users/me',
  requireAuth,
  validate({ body: UpdateProfileBody }),
  updateMeHandler,
)

const searchHandler: RequestHandler = async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError()
  }

  const parsedQuery = UserSearchQuery.safeParse(req.query)
  if (!parsedQuery.success) {
    const details = parsedQuery.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'query',
      message: issue.message,
    }))
    throw new ValidationError('Invalid request', details)
  }

  const { q, limit } = parsedQuery.data
  const users = await prisma.user.findMany({
    where: {
      id: { not: req.auth.userId },
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    },
    orderBy: { username: 'asc' },
    take: limit,
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      createdAt: true,
    },
  })

  res
    .status(200)
    .json(users.map((user) => UserDto.parse({ ...user, createdAt: user.createdAt.toISOString() })))
}

router.get('/users', requireAuth, searchHandler)

const publicProfileHandler: RequestHandler = async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError()
  }

  const userId = req.params.id
  if (typeof userId !== 'string') {
    throw new NotFoundError('User not found')
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      createdAt: true,
    },
  })

  if (!user) {
    throw new NotFoundError('User not found')
  }

  res.status(200).json(UserDto.parse({ ...user, createdAt: user.createdAt.toISOString() }))
}

router.get('/users/:id', requireAuth, publicProfileHandler)

export default router
