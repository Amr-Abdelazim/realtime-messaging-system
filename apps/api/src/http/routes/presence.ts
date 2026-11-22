import { PresenceListResponse, PresenceQuery } from '@realtime-messaging/contracts'
import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'

import { UnauthenticatedError, ValidationError } from '../errors/index.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { prisma } from '../../infra/prisma.js'
import { PresenceService } from '../../modules/presence/presence.service.js'

const router: ExpressRouter = Router()
const presence = new PresenceService()

const getPresenceHandler: RequestHandler = async (req, res) => {
  if (!req.auth) {
    throw new UnauthenticatedError()
  }

  const parsedQuery = PresenceQuery.safeParse(req.query)
  if (!parsedQuery.success) {
    const details = parsedQuery.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'query',
      message: issue.message,
    }))
    throw new ValidationError('Invalid request', details)
  }

  const ids = [...new Set(parsedQuery.data.ids)]
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, lastSeenAt: true },
  })
  const usersById = new Map(users.map((user) => [user.id, user]))
  const statuses = await presence.getPresence(users.map(({ id }) => id))

  const items = ids.flatMap((userId) => {
    const user = usersById.get(userId)
    if (!user) {
      return []
    }

    const status = statuses.get(userId)
    const online = status?.online ?? false
    return [
      {
        userId,
        online,
        lastSeenAt: online ? null : (status?.lastSeenAt ?? user.lastSeenAt?.toISOString() ?? null),
      },
    ]
  })

  res.status(200).json(PresenceListResponse.parse({ items }))
}

router.get('/presence', requireAuth, getPresenceHandler)

export default router
