import { MeDto } from '@realtime-messaging/contracts'
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'

import { UnauthenticatedError } from '../errors/index.js'
import { requireAuth } from '../middleware/requireAuth.js'
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

export default router
