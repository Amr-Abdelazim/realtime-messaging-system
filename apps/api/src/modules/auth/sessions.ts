import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { env } from '../../config/env.js'
import { generateRefreshToken, hashRefreshToken } from './tokens.js'

type CreateSessionInput = {
  userId: string
  familyId?: string
  userAgent: string | null
  ip: string | null
}

export async function createSession(
  input: CreateSessionInput,
  transaction: Prisma.TransactionClient,
): Promise<{ id: string; refreshToken: string }> {
  const refreshToken = generateRefreshToken()
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000)

  const session = await transaction.session.create({
    data: {
      userId: input.userId,
      familyId: input.familyId ?? randomUUID(),
      tokenHash: hashRefreshToken(refreshToken),
      userAgent: input.userAgent,
      ip: input.ip,
      expiresAt,
    },
    select: { id: true },
  })

  return { id: session.id, refreshToken }
}
