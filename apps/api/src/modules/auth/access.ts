import { errors as joseErrors, type JWTPayload } from 'jose'

import { TokenExpiredError, UnauthenticatedError } from '../../http/errors/index.js'
import { redis } from '../../infra/redis.js'
import { revokedSessionKey } from './sessions.js'
import { verifyAccessToken } from './tokens.js'

export type AccessTokenContext = {
  userId: string
  sessionId: string
  tokenExp: number
}

export async function authenticateAccessToken(token: string): Promise<AccessTokenContext> {
  let payload: JWTPayload
  try {
    const verified = await verifyAccessToken(token)
    payload = verified.payload
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new TokenExpiredError()
    }
    if (error instanceof joseErrors.JOSEError) {
      throw new UnauthenticatedError('Invalid access token')
    }

    throw error
  }

  if (
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    throw new UnauthenticatedError('Invalid access token')
  }

  const revoked = await redis.get(revokedSessionKey(payload.sid))
  if (revoked !== null) {
    throw new UnauthenticatedError('Session revoked')
  }

  return { userId: payload.sub, sessionId: payload.sid, tokenExp: payload.exp }
}
