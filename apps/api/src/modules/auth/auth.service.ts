import { Prisma } from '@prisma/client'
import argon2 from 'argon2'

import type { AuthResponse, LoginBody, RegisterBody } from '@realtime-messaging/contracts'
import { ConflictError, UnauthenticatedError } from '../../http/errors/index.js'
import { prisma } from '../../infra/prisma.js'
import { createSession } from './sessions.js'
import { signAccessToken } from './tokens.js'

type AuthContext = {
  userAgent: string | null
  ip: string | null
}

type AuthSessionResult = AuthResponse & { refreshToken: string }

const authUserSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  createdAt: true,
} satisfies Prisma.UserSelect

type AuthUser = Prisma.UserGetPayload<{ select: typeof authUserSelect }>

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$TvS7QDG6VW7xWdVJqmDYjA$LYBm8JV1jJYI2F/aId29FZP8gL1x7rGTw0NsBVP3cyY'

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

async function createAuthSession(
  user: AuthUser,
  context: AuthContext,
  transaction: Prisma.TransactionClient,
): Promise<AuthSessionResult> {
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
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.toISOString(),
    },
    accessToken,
    refreshToken: session.refreshToken,
  }
}

export async function register(
  input: RegisterBody,
  context: AuthContext,
): Promise<AuthSessionResult> {
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

      return createAuthSession(user, context, transaction)
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

export async function login(input: LoginBody, context: AuthContext): Promise<AuthSessionResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      ...authUserSelect,
      passwordHash: true,
    },
  })

  const passwordMatches = user
    ? await argon2.verify(user.passwordHash, input.password)
    : await argon2.verify(DUMMY_PASSWORD_HASH, input.password)

  if (!user || !passwordMatches) {
    throw new UnauthenticatedError('Invalid email or password')
  }

  return prisma.$transaction((transaction) => createAuthSession(user, context, transaction))
}
