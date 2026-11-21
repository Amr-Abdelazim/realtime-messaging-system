import { randomBytes, createHash } from 'node:crypto'
import { jwtVerify, SignJWT, type JWTPayload } from 'jose'

import { env } from '../../config/env.js'

const accessTokenSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET)

export async function signAccessToken({
  userId,
  sessionId,
}: {
  userId: string
  sessionId: string
}): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000)

  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + env.JWT_ACCESS_TTL_SECONDS)
    .sign(accessTokenSecret)
}

export function verifyAccessToken(token: string): Promise<{ payload: JWTPayload }> {
  return jwtVerify(token, accessTokenSecret, {
    algorithms: ['HS256'],
    requiredClaims: ['sub', 'sid', 'exp'],
  })
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
