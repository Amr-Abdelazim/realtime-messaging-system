import { errors as joseErrors, type JWTPayload } from 'jose'
import type { RequestHandler } from 'express'

import { TokenExpiredError, UnauthenticatedError } from '../errors/index.js'
import { redis } from '../../infra/redis.js'
import { revokedSessionKey } from '../../modules/auth/sessions.js'
import { verifyAccessToken } from '../../modules/auth/tokens.js'

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

  let payload: JWTPayload
  try {
    const verified = await verifyAccessToken(token)
    payload = verified.payload
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      next(new TokenExpiredError())
      return
    }
    if (error instanceof joseErrors.JOSEError) {
      next(new UnauthenticatedError('Invalid access token'))
      return
    }

    next(error)
    return
  }

  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    next(new UnauthenticatedError('Invalid access token'))
    return
  }

  const revoked = await redis.get(revokedSessionKey(payload.sid))
  if (revoked !== null) {
    next(new UnauthenticatedError('Session revoked'))
    return
  }

  req.auth = { userId: payload.sub, sessionId: payload.sid }
  next()
}
