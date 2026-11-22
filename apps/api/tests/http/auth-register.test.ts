import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'
import { jwtVerify, SignJWT } from 'jose'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { AuthResponse } from '@realtime-messaging/contracts'
import { env } from '../../src/config/env.js'
import { createApp } from '../../src/http/app.js'
import { redis } from '../../src/infra/redis.js'
import { REFRESH_COOKIE_NAME } from '../../src/modules/auth/cookies.js'
import { hashRefreshToken, signAccessToken } from '../../src/modules/auth/tokens.js'
import { revokedSessionKey } from '../../src/modules/auth/sessions.js'
import { disconnectDb, resetDb } from '../helpers/db.js'

const app = createApp({
  rateLimits: {
    api: { limit: 1000, windowSeconds: 60 },
    register: { limit: 1000, windowSeconds: 60 },
    login: { limit: 1000, windowSeconds: 60 },
  },
})
const prisma = new PrismaClient()

const makeRegistration = () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  return {
    email: `${suffix}@example.com`,
    username: `user_${suffix}`,
    password: 'Password123!',
    displayName: 'Test User',
  }
}

const makeTestIp = () => `192.0.2.${Math.floor(Math.random() * 254) + 1}`

function getRefreshToken(response: { headers: { 'set-cookie'?: string[] } }): string {
  const cookie = response.headers['set-cookie']?.find((value) =>
    value.startsWith(`${REFRESH_COOKIE_NAME}=`),
  )
  const cookieValue = cookie?.split(';', 1)[0]
  const token = cookieValue?.slice(`${REFRESH_COOKIE_NAME}=`.length)

  if (!token) {
    throw new Error('Refresh cookie was not set')
  }

  return token
}

async function createRegisteredSession(
  overrides: Partial<ReturnType<typeof makeRegistration>> = {},
) {
  const registration = { ...makeRegistration(), ...overrides }
  const response = await request(app).post('/api/v1/auth/register').send(registration).expect(201)

  return {
    registration,
    auth: AuthResponse.parse(response.body),
    refreshToken: getRefreshToken(response),
  }
}

describe.skipIf(process.env.CI !== 'true')('Authentication API', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await disconnectDb()
    await prisma.$disconnect()
  })

  it('creates a user and session, returning an access token and refresh cookie', async () => {
    const registration = makeRegistration()
    const response = await request(app)
      .post('/api/v1/auth/register')
      .set('user-agent', 't05-test-agent')
      .send({
        ...registration,
        email: registration.email.toUpperCase(),
        username: registration.username.toUpperCase(),
      })

    expect(response.status).toBe(201)
    const auth = AuthResponse.parse(response.body)
    expect(auth.user.email).toBe(registration.email)
    expect(auth.user.username).toBe(registration.username)
    expect(auth.user.displayName).toBe(registration.displayName)

    const cookieHeader = response.headers['set-cookie']
    const cookie = Array.isArray(cookieHeader)
      ? cookieHeader.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`))
      : cookieHeader
    expect(cookie).toBeDefined()
    if (!cookie) {
      throw new Error('Refresh cookie was not set')
    }
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/api/v1/auth')
    expect(cookie).toContain('Max-Age=2592000')
    expect(cookie).not.toContain('Secure')

    const cookieValue = cookie.split(';', 1)[0]
    if (!cookieValue) {
      throw new Error('Refresh cookie was empty')
    }
    const refreshToken = cookieValue.slice(`${REFRESH_COOKIE_NAME}=`.length)
    expect(Buffer.from(refreshToken, 'base64url')).toHaveLength(32)
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.user.id },
    })
    expect(user.passwordHash).not.toBe(registration.password)
    expect(await argon2.verify(user.passwordHash, registration.password)).toBe(true)

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    })
    expect(session.tokenHash).toBe(hashRefreshToken(refreshToken))
    expect(session.tokenHash).not.toBe(refreshToken)
    expect(session.familyId).not.toBe('')
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(session.userAgent).toBe('t05-test-agent')

    const { payload } = await jwtVerify(
      auth.accessToken,
      new TextEncoder().encode(env.JWT_ACCESS_SECRET),
    )
    expect(payload.sub).toBe(user.id)
    expect(payload.sid).toBe(session.id)
    expect(payload.iat).toBeTypeOf('number')
    expect(payload.exp).toBeTypeOf('number')
  })

  it('returns a field-specific conflict for duplicate email regardless of case', async () => {
    const registration = makeRegistration()
    await request(app).post('/api/v1/auth/register').send(registration).expect(201)

    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        ...registration,
        email: registration.email.toUpperCase(),
        username: `${registration.username}_2`,
      })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.details).toEqual({ field: 'email' })
  })

  it('returns a field-specific conflict for duplicate username regardless of case', async () => {
    const registration = makeRegistration()
    await request(app).post('/api/v1/auth/register').send(registration).expect(201)

    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        ...registration,
        email: `other-${registration.email}`,
        username: registration.username.toUpperCase(),
      })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.details).toEqual({ field: 'username' })
  })

  it('rejects invalid registration fields with validation details', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      email: 'not-an-email',
      username: 'a',
      password: 'short',
      displayName: ' ',
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'username' }),
        expect.objectContaining({ path: 'password' }),
        expect.objectContaining({ path: 'displayName' }),
      ]),
    )
  })

  it('logs in and uses the access token to get the current user', async () => {
    const registration = makeRegistration()
    await request(app).post('/api/v1/auth/register').send(registration).expect(201)

    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('user-agent', 't06-login-test-agent')
      .send({
        email: registration.email.toUpperCase(),
        password: registration.password,
      })

    expect(response.status).toBe(200)
    const auth = AuthResponse.parse(response.body)
    expect(auth.user.email).toBe(registration.email)
    expect(auth.user.username).toBe(registration.username)
    expect(response.headers['set-cookie']?.[0]).toContain(`${REFRESH_COOKIE_NAME}=`)
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly')
    expect(response.headers['set-cookie']?.[0]).toContain('SameSite=Lax')

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: auth.user.id, userAgent: 't06-login-test-agent' },
    })
    expect(session.ip).toBeTruthy()

    const meResponse = await request(app)
      .get('/api/v1/users/me')
      .set('authorization', `Bearer ${auth.accessToken}`)

    expect(meResponse.status).toBe(200)
    expect(meResponse.body).toEqual(auth.user)
  })

  it('returns the same unauthenticated response for an unknown email and a wrong password', async () => {
    const registration = makeRegistration()
    await request(app).post('/api/v1/auth/register').send(registration).expect(201)

    const wrongPassword = await request(app).post('/api/v1/auth/login').send({
      email: registration.email,
      password: 'WrongPassword123!',
    })
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: `unknown-${registration.email}`,
        password: registration.password,
      })

    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.body.error.code).toBe('UNAUTHENTICATED')
    expect(unknownEmail.body.error.code).toBe('UNAUTHENTICATED')
    expect(wrongPassword.body.error.message).toBe('Invalid email or password')
    expect(unknownEmail.body.error.message).toBe('Invalid email or password')
  })

  it('rejects requests to the current-user route without a bearer token', async () => {
    const response = await request(app).get('/api/v1/users/me')

    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('updates and validates the authenticated user profile', async () => {
    const { auth, registration } = await createRegisteredSession()
    const response = await request(app)
      .patch('/api/v1/users/me')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .send({
        displayName: '  Updated Name  ',
        avatarUrl: 'https://example.com/avatar.png',
      })
      .expect(200)

    expect(response.body).toMatchObject({
      id: auth.user.id,
      email: registration.email,
      displayName: 'Updated Name',
      avatarUrl: 'https://example.com/avatar.png',
    })
    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } })
    expect(updatedUser.displayName).toBe('Updated Name')
    expect(updatedUser.avatarUrl).toBe('https://example.com/avatar.png')

    await request(app)
      .patch('/api/v1/users/me')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .send({ avatarUrl: null })
      .expect(200)
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } })).avatarUrl,
    ).toBeNull()

    const missingFields = await request(app)
      .patch('/api/v1/users/me')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .send({})
    expect(missingFields.status).toBe(400)
    expect(missingFields.body.error.code).toBe('VALIDATION_ERROR')

    const insecureAvatar = await request(app)
      .patch('/api/v1/users/me')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .send({ avatarUrl: 'http://example.com/avatar.png' })
    expect(insecureAvatar.status).toBe(400)
    expect(insecureAvatar.body.error.code).toBe('VALIDATION_ERROR')

    const blankName = await request(app)
      .patch('/api/v1/users/me')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .send({ displayName: '   ' })
    expect(blankName.status).toBe(400)
    expect(blankName.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('searches users case-insensitively, excludes self, and applies the limit', async () => {
    const { auth } = await createRegisteredSession({
      username: 'needle_self',
      displayName: 'Needle Self',
    })
    const fixtures = [
      ...Array.from({ length: 11 }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        return {
          email: `display-${suffix}@example.com`,
          username: `display_${suffix}`,
          passwordHash: 'test-password-hash',
          displayName: `Needle Display ${suffix}`,
        }
      }),
      ...Array.from({ length: 11 }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        return {
          email: `needle-${suffix}@example.com`,
          username: `needle_${suffix}`,
          passwordHash: 'test-password-hash',
          displayName: `Other User ${suffix}`,
        }
      }),
    ]
    await prisma.user.createMany({ data: fixtures })

    const search = await request(app)
      .get('/api/v1/users?q=NEEDLE&limit=20')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .expect(200)

    expect(search.body).toHaveLength(20)
    expect(search.body.map((user: { username: string }) => user.username)).toEqual(
      [...search.body.map((user: { username: string }) => user.username)].sort(),
    )
    expect(search.body.some((user: { id: string }) => user.id === auth.user.id)).toBe(false)
    expect(search.body.some((user: { username: string }) => user.username === 'display_00')).toBe(
      true,
    )
    expect(search.body.some((user: { username: string }) => user.username === 'needle_00')).toBe(
      true,
    )
    expect(search.body.every((user: object) => !('email' in user))).toBe(true)

    const defaultLimit = await request(app)
      .get('/api/v1/users?q=NEEDLE')
      .set('authorization', `Bearer ${auth.accessToken}`)
      .expect(200)
    expect(defaultLimit.body).toHaveLength(10)

    const shortQuery = await request(app)
      .get('/api/v1/users?q=N')
      .set('authorization', `Bearer ${auth.accessToken}`)
    expect(shortQuery.status).toBe(400)
    expect(shortQuery.body.error.code).toBe('VALIDATION_ERROR')

    const oversizedLimit = await request(app)
      .get('/api/v1/users?q=NEEDLE&limit=21')
      .set('authorization', `Bearer ${auth.accessToken}`)
    expect(oversizedLimit.status).toBe(400)
    expect(oversizedLimit.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns a public user profile and 404 for an unknown user', async () => {
    const { auth } = await createRegisteredSession()
    const { auth: profile } = await createRegisteredSession({ displayName: 'Public Profile' })

    const response = await request(app)
      .get(`/api/v1/users/${profile.user.id}`)
      .set('authorization', `Bearer ${auth.accessToken}`)
      .expect(200)

    expect(response.body).toMatchObject({
      id: profile.user.id,
      username: profile.user.username,
      displayName: 'Public Profile',
      avatarUrl: null,
    })
    expect(response.body).not.toHaveProperty('email')

    await request(app)
      .get(`/api/v1/users/${randomUUID()}`)
      .set('authorization', `Bearer ${auth.accessToken}`)
      .expect(404)
  })

  it('requires authentication for profile updates, search, and public profiles', async () => {
    const requests = await Promise.all([
      request(app).patch('/api/v1/users/me').send({ displayName: 'Updated' }),
      request(app).get('/api/v1/users?q=ad'),
      request(app).get(`/api/v1/users/${randomUUID()}`),
    ])

    expect(requests.map((response) => response.status)).toEqual([401, 401, 401])
    expect(requests.map((response) => response.body.error.code)).toEqual([
      'UNAUTHENTICATED',
      'UNAUTHENTICATED',
      'UNAUTHENTICATED',
    ])
  })

  it('creates one direct conversation for either participant order', async () => {
    const alice = await createRegisteredSession({ displayName: 'Alice' })
    const bob = await createRegisteredSession({ displayName: 'Bob' })
    const createConversation = (accessToken: string, userId: string) =>
      request(app)
        .post('/api/v1/conversations')
        .set('authorization', `Bearer ${accessToken}`)
        .send({ type: 'DIRECT', userId })

    const created = await createConversation(alice.auth.accessToken, bob.auth.user.id).expect(201)
    expect(created.body).toMatchObject({
      type: 'DIRECT',
      name: null,
      lastSeq: 0,
      lastMessage: null,
      unreadCount: 0,
      myLastReadSeq: 0,
      peerPresence: null,
    })
    expect(created.body.members).toHaveLength(2)
    expect(created.body.members.map((member: { userId: string }) => member.userId).sort()).toEqual(
      [alice.auth.user.id, bob.auth.user.id].sort(),
    )

    const directKey = [alice.auth.user.id, bob.auth.user.id].sort().join(':')
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { directKey } })
    expect(conversation.lastMessageAt).not.toBeNull()
    const participants = await prisma.participant.findMany({
      where: { conversationId: conversation.id },
    })
    expect(participants).toHaveLength(2)
    expect(
      participants.every(
        (participant) => participant.lastDeliveredSeq === 0 && participant.lastReadSeq === 0,
      ),
    ).toBe(true)

    const openedInReverse = await createConversation(
      bob.auth.accessToken,
      alice.auth.user.id,
    ).expect(200)
    expect(openedInReverse.body.id).toBe(created.body.id)
    expect(await prisma.conversation.count()).toBe(1)
  })

  it('handles twenty concurrent opens of the same direct conversation', async () => {
    const alice = await createRegisteredSession()
    const bob = await createRegisteredSession()
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app)
          .post('/api/v1/conversations')
          .set('authorization', `Bearer ${alice.auth.accessToken}`)
          .send({ type: 'DIRECT', userId: bob.auth.user.id }),
      ),
    )

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1)
    expect(responses.filter((response) => response.status === 200)).toHaveLength(19)
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1)
    expect(await prisma.conversation.count()).toBe(1)
    expect(await prisma.participant.count()).toBe(2)
  })

  it('rejects self conversations and unknown target users', async () => {
    const alice = await createRegisteredSession()

    const self = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${alice.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: alice.auth.user.id })
    expect(self.status).toBe(400)
    expect(self.body.error.code).toBe('VALIDATION_ERROR')

    const unknownUser = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${alice.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: randomUUID() })
    expect(unknownUser.status).toBe(404)
    expect(unknownUser.body.error.code).toBe('NOT_FOUND')
  })

  it('returns conversation details only to active members', async () => {
    const alice = await createRegisteredSession()
    const bob = await createRegisteredSession()
    const charlie = await createRegisteredSession()
    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${alice.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: bob.auth.user.id })
      .expect(201)

    await request(app)
      .get(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${bob.auth.accessToken}`)
      .expect(200)

    const nonMember = await request(app)
      .get(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${charlie.auth.accessToken}`)
    expect(nonMember.status).toBe(404)
    expect(nonMember.body.error.code).toBe('NOT_FOUND')

    const unauthenticated = await request(app).get(`/api/v1/conversations/${created.body.id}`)
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('returns TOKEN_EXPIRED for an expired access token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expiredToken = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET))

    const response = await request(app)
      .get('/api/v1/users/me')
      .set('authorization', `Bearer ${expiredToken}`)

    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('TOKEN_EXPIRED')
  })

  it('rejects a token with an invalid signature', async () => {
    const invalidToken = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('not-the-configured-test-secret-32-chars'))

    const response = await request(app)
      .get('/api/v1/users/me')
      .set('authorization', `Bearer ${invalidToken}`)

    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects an access token when its session id is revoked in Redis', async () => {
    const sessionId = randomUUID()
    const redisKey = `revoked:sid:${sessionId}`
    await redis.set(redisKey, '1')

    try {
      const accessToken = await signAccessToken({
        userId: randomUUID(),
        sessionId,
      })
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('authorization', `Bearer ${accessToken}`)

      expect(response.status).toBe(401)
      expect(response.body.error.code).toBe('UNAUTHENTICATED')
    } finally {
      await redis.del(redisKey)
    }
  })

  it('rejects invalid login fields with validation details', async () => {
    const response = await request(app).post('/api/v1/auth/login').send({
      email: 'not-an-email',
      password: '',
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'password' }),
      ]),
    )
  })

  it('limits the eleventh login attempt from the same IP and sets Retry-After', async () => {
    const ip = makeTestIp()
    const limitedApp = createApp({ trustProxy: 1 })
    const failureKeys: string[] = []

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const email = `unknown-${randomUUID()}@example.com`
        failureKeys.push(`login:fail:${email}`)
        const response = await request(limitedApp)
          .post('/api/v1/auth/login')
          .set('x-forwarded-for', ip)
          .send({ email, password: 'WrongPassword123!' })
        expect(response.status).toBe(401)
      }

      const email = `unknown-${randomUUID()}@example.com`
      failureKeys.push(`login:fail:${email}`)
      const limited = await request(limitedApp)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', ip)
        .send({ email, password: 'WrongPassword123!' })

      expect(limited.status).toBe(429)
      expect(limited.body.error.code).toBe('RATE_LIMITED')
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    } finally {
      await redis.del(`rate-limit:api:${ip}`, `rate-limit:login:${ip}`, ...failureKeys)
    }
  })

  it('applies login rate limits independently per IP', async () => {
    const firstIp = makeTestIp()
    let secondIp = makeTestIp()
    while (secondIp === firstIp) {
      secondIp = makeTestIp()
    }
    const limitedApp = createApp({
      trustProxy: 1,
      rateLimits: {
        api: { limit: 100, windowSeconds: 60 },
        login: { limit: 1, windowSeconds: 60 },
      },
    })
    const failureKeys: string[] = []

    const attemptLogin = async (ip: string) => {
      const email = `unknown-${randomUUID()}@example.com`
      failureKeys.push(`login:fail:${email}`)
      return request(limitedApp)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', ip)
        .send({ email, password: 'WrongPassword123!' })
    }

    try {
      expect((await attemptLogin(firstIp)).status).toBe(401)
      const limited = await attemptLogin(firstIp)
      expect(limited.status).toBe(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
      expect((await attemptLogin(secondIp)).status).toBe(401)
    } finally {
      await redis.del(
        `rate-limit:api:${firstIp}`,
        `rate-limit:login:${firstIp}`,
        `rate-limit:api:${secondIp}`,
        `rate-limit:login:${secondIp}`,
        ...failureKeys,
      )
    }
  })

  it('rate limits registration by IP', async () => {
    const ip = makeTestIp()
    const limitedApp = createApp({
      trustProxy: 1,
      rateLimits: {
        api: { limit: 100, windowSeconds: 60 },
        register: { limit: 1, windowSeconds: 60 },
      },
    })

    try {
      expect(
        (
          await request(limitedApp)
            .post('/api/v1/auth/register')
            .set('x-forwarded-for', ip)
            .send(makeRegistration())
        ).status,
      ).toBe(201)
      const limited = await request(limitedApp)
        .post('/api/v1/auth/register')
        .set('x-forwarded-for', ip)
        .send(makeRegistration())

      expect(limited.status).toBe(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    } finally {
      await redis.del(`rate-limit:api:${ip}`, `rate-limit:register:${ip}`)
    }
  })

  it('applies the general API limit to all versioned routes', async () => {
    const ip = makeTestIp()
    const limitedApp = createApp({
      trustProxy: 1,
      rateLimits: {
        api: { limit: 1, windowSeconds: 60 },
      },
    })

    try {
      const unauthenticated = await request(limitedApp)
        .get('/api/v1/users/me')
        .set('x-forwarded-for', ip)
      expect(unauthenticated.status).toBe(401)

      const limited = await request(limitedApp).get('/api/v1/users/me').set('x-forwarded-for', ip)
      expect(limited.status).toBe(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    } finally {
      await redis.del(`rate-limit:api:${ip}`)
    }
  })

  it('locks an account after five failed passwords, including a correct sixth attempt', async () => {
    const registration = makeRegistration()
    await request(app).post('/api/v1/auth/register').send(registration).expect(201)

    const ip = makeTestIp()
    const limitedApp = createApp({
      trustProxy: 1,
      rateLimits: {
        api: { limit: 100, windowSeconds: 60 },
        login: { limit: 100, windowSeconds: 60 },
      },
    })
    const login = (password: string) =>
      request(limitedApp)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', ip)
        .send({ email: registration.email, password })

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await login('WrongPassword123!')).status).toBe(401)
      }

      const fifthFailure = await login('WrongPassword123!')
      expect(fifthFailure.status).toBe(429)
      expect(fifthFailure.body.error.code).toBe('RATE_LIMITED')
      expect(Number(fifthFailure.headers['retry-after'])).toBeGreaterThan(0)

      const correctSixthAttempt = await login(registration.password)
      expect(correctSixthAttempt.status).toBe(429)
      expect(correctSixthAttempt.body.error.code).toBe('RATE_LIMITED')
    } finally {
      await redis.del(
        `login:fail:${registration.email}`,
        `rate-limit:api:${ip}`,
        `rate-limit:login:${ip}`,
      )
    }
  })

  it('clears the failed-login counter on successful login', async () => {
    const registration = makeRegistration()
    await request(app).post('/api/v1/auth/register').send(registration).expect(201)

    const ip = makeTestIp()
    const limitedApp = createApp({
      trustProxy: 1,
      rateLimits: {
        api: { limit: 100, windowSeconds: 60 },
        login: { limit: 100, windowSeconds: 60 },
      },
    })
    const failureKey = `login:fail:${registration.email}`
    const login = (password: string) =>
      request(limitedApp)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', ip)
        .send({ email: registration.email, password })

    try {
      expect((await login('WrongPassword123!')).status).toBe(401)
      expect((await login('WrongPassword123!')).status).toBe(401)
      expect(await redis.get(failureKey)).toBe('2')

      expect((await login(registration.password)).status).toBe(200)
      expect(await redis.get(failureKey)).toBeNull()

      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await login('WrongPassword123!')).status).toBe(401)
      }
      expect((await login('WrongPassword123!')).status).toBe(429)
    } finally {
      await redis.del(failureKey, `rate-limit:api:${ip}`, `rate-limit:login:${ip}`)
    }
  })

  it('rotates tokens, tolerates a grace-period replay, and logs out', async () => {
    const { auth, refreshToken: originalRefreshToken } = await createRegisteredSession()
    const originalSession = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(originalRefreshToken) },
    })

    const firstRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${originalRefreshToken}`)
      .set('user-agent', 't07-refresh-test-agent')
      .expect(200)
    const firstRotatedToken = getRefreshToken(firstRefresh)
    const firstRotatedSession = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(firstRotatedToken) },
    })

    expect(firstRefresh.body.accessToken).toBeTypeOf('string')
    expect(firstRotatedToken).not.toBe(originalRefreshToken)
    expect(originalSession.familyId).toBe(firstRotatedSession.familyId)
    expect(firstRotatedSession.userAgent).toBe('t07-refresh-test-agent')
    expect(
      (await prisma.session.findUniqueOrThrow({ where: { id: originalSession.id } })).revokedAt,
    ).not.toBeNull()

    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${originalRefreshToken}`)
      .expect(401)
    expect(replay.headers['set-cookie']?.[0]).toContain(`${REFRESH_COOKIE_NAME}=;`)

    const currentUser = await request(app)
      .get('/api/v1/users/me')
      .set('authorization', `Bearer ${firstRefresh.body.accessToken}`)
      .expect(200)
    expect(currentUser.body.id).toBe(auth.user.id)

    const secondRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${firstRotatedToken}`)
      .expect(200)
    const currentRefreshToken = getRefreshToken(secondRefresh)
    const currentSession = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(currentRefreshToken) },
    })
    const redisKey = revokedSessionKey(currentSession.id)

    try {
      await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${currentRefreshToken}`)
        .expect(204)
      await request(app)
        .get('/api/v1/users/me')
        .set('authorization', `Bearer ${secondRefresh.body.accessToken}`)
        .expect(401)
      const loggedOutRefresh = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${currentRefreshToken}`)
        .expect(401)
      expect(loggedOutRefresh.headers['set-cookie']?.[0]).toContain(`${REFRESH_COOKIE_NAME}=;`)
    } finally {
      await redis.del(redisKey)
    }
  })

  it('revokes the whole family when a refresh token is reused after the grace period', async () => {
    const { auth, refreshToken: stolenRefreshToken } = await createRegisteredSession()
    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolenRefreshToken}`)
      .expect(200)
    const rotatedPayload = await jwtVerify(
      rotated.body.accessToken,
      new TextEncoder().encode(env.JWT_ACCESS_SECRET),
    )
    if (typeof rotatedPayload.payload.sid !== 'string') {
      throw new Error('Rotated token did not contain a session id')
    }

    const originalSession = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(stolenRefreshToken) },
    })
    await prisma.session.update({
      where: { id: originalSession.id },
      data: { revokedAt: new Date(Date.now() - 11_000) },
    })

    try {
      const reuse = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolenRefreshToken}`)
        .expect(401)
      expect(reuse.headers['set-cookie']?.[0]).toContain(`${REFRESH_COOKIE_NAME}=;`)

      const family = await prisma.session.findMany({
        where: { familyId: originalSession.familyId },
      })
      expect(family.length).toBeGreaterThanOrEqual(2)
      expect(family.every((session) => session.revokedAt !== null)).toBe(true)
      expect(family.every((session) => session.userId === auth.user.id)).toBe(true)
      expect(await redis.get(revokedSessionKey(rotatedPayload.payload.sid))).toBe('1')

      await request(app)
        .get('/api/v1/users/me')
        .set('authorization', `Bearer ${rotated.body.accessToken}`)
        .expect(401)
      expect(auth.user.id).toBe(originalSession.userId)
    } finally {
      const family = await prisma.session.findMany({
        where: { familyId: originalSession.familyId },
        select: { id: true },
      })
      await Promise.all(family.map(({ id }) => redis.del(revokedSessionKey(id))))
    }
  })

  it('rejects and clears an expired refresh session', async () => {
    const { refreshToken } = await createRegisteredSession()
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(refreshToken) },
    })
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    })

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
      .expect(401)

    expect(response.headers['set-cookie']?.[0]).toContain(`${REFRESH_COOKIE_NAME}=;`)
    expect(
      await prisma.session.count({
        where: { userId: session.userId },
      }),
    ).toBe(1)
  })

  it('logs out idempotently and immediately revokes the access token', async () => {
    const { auth, refreshToken } = await createRegisteredSession()
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(refreshToken) },
    })
    const redisKey = revokedSessionKey(session.id)

    try {
      const logout = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
        .expect(204)
      expect(logout.headers['set-cookie']?.[0]).toContain(`${REFRESH_COOKIE_NAME}=;`)
      expect(
        (await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt,
      ).not.toBeNull()
      expect(await redis.get(redisKey)).toBe('1')
      expect(await redis.ttl(redisKey)).toBeLessThanOrEqual(env.JWT_ACCESS_TTL_SECONDS)
      expect(await redis.ttl(redisKey)).toBeGreaterThan(0)

      await request(app)
        .get('/api/v1/users/me')
        .set('authorization', `Bearer ${auth.accessToken}`)
        .expect(401)

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
        .expect(204)
      await request(app).post('/api/v1/auth/logout').expect(204)
    } finally {
      await redis.del(redisKey)
    }
  })
})
