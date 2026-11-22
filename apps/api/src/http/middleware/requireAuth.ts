import type { RequestHandler } from 'express'

import { UnauthenticatedError } from '../errors/index.js'
import { authenticateAccessToken } from '../../modules/auth/access.js'

declare global {
  // Express request types are extended through this namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string
        sessionId: string
      }
    }
  }
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const parts = req.get('authorization')?.trim().split(/\s+/) ?? []
  const [scheme, token] = parts

  if (parts.length !== 2 || scheme?.toLowerCase() !== 'bearer' || !token) {
    next(new UnauthenticatedError())
    return
  }

  let auth: Awaited<ReturnType<typeof authenticateAccessToken>>
  try {
    auth = await authenticateAccessToken(token)
  } catch (error) {
    next(error)
    return
  }

  req.auth = { userId: auth.userId, sessionId: auth.sessionId }
  next()
}
