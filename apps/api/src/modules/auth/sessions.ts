import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { env } from '../../config/env.js'
import { prisma } from '../../infra/prisma.js'
import { redis } from '../../infra/redis.js'
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js'

type CreateSessionInput = {
  userId: string
  familyId?: string
  userAgent: string | null
  ip: string | null
}

type SessionContext = {
  userAgent: string | null
  ip: string | null
}

type RotationOutcome =
  | { kind: 'invalid' }
  | { kind: 'rotated'; accessToken: string; refreshToken: string }
  | { kind: 'reuse'; sessionIds: string[] }

const REFRESH_REUSE_GRACE_MS = 10_000

export function revokedSessionKey(sessionId: string): string {
  return `revoked:sid:${sessionId}`
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

export async function rotateRefreshSession(
  token: string,
  context: SessionContext,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const tokenHash = hashRefreshToken(token)

  const outcome = await prisma.$transaction<RotationOutcome>(async (transaction) => {
    const session = await transaction.session.findUnique({
      where: { tokenHash },
    })

    if (!session) {
      return { kind: 'invalid' }
    }

    const now = new Date()
    if (session.expiresAt <= now) {
      return { kind: 'invalid' }
    }

    if (session.revokedAt) {
      if (now.getTime() - session.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
        return { kind: 'invalid' }
      }

      const familySessions = await transaction.session.findMany({
        where: { familyId: session.familyId },
        select: { id: true },
      })
      await transaction.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: now },
      })

      return { kind: 'reuse', sessionIds: familySessions.map(({ id }) => id) }
    }

    if ((await redis.get(revokedSessionKey(session.id))) !== null) {
      return { kind: 'invalid' }
    }

    const revoked = await transaction.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
    })
    if (revoked.count !== 1) {
      return { kind: 'invalid' }
    }

    const nextSession = await createSession(
      {
        userId: session.userId,
        familyId: session.familyId,
        userAgent: context.userAgent,
        ip: context.ip,
      },
      transaction,
    )
    const accessToken = await signAccessToken({
      userId: session.userId,
      sessionId: nextSession.id,
    })

    return {
      kind: 'rotated',
      accessToken,
      refreshToken: nextSession.refreshToken,
    }
  })

  if (outcome.kind === 'reuse') {
    await Promise.all(
      outcome.sessionIds.map((sessionId) =>
        redis.set(revokedSessionKey(sessionId), '1', 'EX', env.JWT_ACCESS_TTL_SECONDS),
      ),
    )
    return null
  }

  if (outcome.kind === 'invalid') {
    return null
  }

  return {
    accessToken: outcome.accessToken,
    refreshToken: outcome.refreshToken,
  }
}

export async function logoutRefreshSession(token: string | undefined): Promise<void> {
  if (!token) {
    return
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashRefreshToken(token) },
    select: { id: true },
  })
  if (!session) {
    return
  }

  await redis.set(revokedSessionKey(session.id), '1', 'EX', env.JWT_ACCESS_TTL_SECONDS)
  await prisma.session.updateMany({
    where: { id: session.id, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
