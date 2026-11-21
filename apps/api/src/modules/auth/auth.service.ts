import { Prisma } from '@prisma/client'
import argon2 from 'argon2'

import type { AuthResponse, RegisterBody } from '@realtime-messaging/contracts'
import { ConflictError } from '../../http/errors/index.js'
import { prisma } from '../../infra/prisma.js'
import { createSession } from './sessions.js'
import { signAccessToken } from './tokens.js'

type RegistrationContext = {
  userAgent: string | null
  ip: string | null
}

type RegisterResult = AuthResponse & { refreshToken: string }

function duplicateField(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target
  return Array.isArray(target) ? target.join(',') : String(target ?? '')
}

function duplicateConflict(target: string): ConflictError | undefined {
  if (target.includes('email')) {
    return new ConflictError('Email already in use', { field: 'email' })
  }
  if (target.includes('username')) {
    return new ConflictError('Username already in use', { field: 'username' })
  }
}

export async function register(
  input: RegisterBody,
  context: RegistrationContext,
): Promise<RegisterResult> {
  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email: input.email }, { username: input.username }],
    },
    select: { email: true, username: true },
  })

  if (existingUser?.email === input.email) {
    throw new ConflictError('Email already in use', { field: 'email' })
  }
  if (existingUser?.username === input.username) {
    throw new ConflictError('Username already in use', { field: 'username' })
  }

  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  })

  try {
    return await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          email: input.email,
          username: input.username,
          passwordHash,
          displayName: input.displayName,
        },
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          createdAt: true,
        },
      })

      const session = await createSession(
        {
          userId: user.id,
          userAgent: context.userAgent,
          ip: context.ip,
        },
        transaction,
      )
      const accessToken = await signAccessToken({
        userId: user.id,
        sessionId: session.id,
      })

      return {
        user: { ...user, createdAt: user.createdAt.toISOString() },
        accessToken,
        refreshToken: session.refreshToken,
      }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const conflict = duplicateConflict(duplicateField(error))
      if (conflict) {
        throw conflict
      }
    }

    throw error
  }
}
