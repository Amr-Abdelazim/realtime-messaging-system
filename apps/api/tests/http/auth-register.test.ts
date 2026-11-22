import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'
import { jwtVerify, SignJWT } from 'jose'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { AuthResponse } from '@realtime-messaging/contracts'
import { env } from '../../src/config/env.js'
import { createApp } from '../../src/http/app.js'
import { prisma as apiPrisma } from '../../src/infra/prisma.js'
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
const observedQueries: string[] = []

apiPrisma.$on('query', ({ query }) => observedQueries.push(query))

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

  it('creates groups with deduplicated members, owner role, and an initial system message', async () => {
    const owner = await createRegisteredSession({ displayName: 'Group Owner' })
    const firstMember = await createRegisteredSession({ displayName: 'First Member' })
    const secondMember = await createRegisteredSession({ displayName: 'Second Member' })

    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: '  Project Team  ',
        memberIds: [
          owner.auth.user.id,
          firstMember.auth.user.id,
          firstMember.auth.user.id,
          secondMember.auth.user.id,
        ],
      })
      .expect(201)

    expect(created.body.name).toBe('Project Team')
    expect(created.body.members).toHaveLength(3)
    expect(created.body.lastSeq).toBe(1)
    expect(created.body.lastMessage).toMatchObject({
      type: 'SYSTEM',
      content: 'Group Owner created the group',
      seq: 1,
    })

    const participants = await prisma.participant.findMany({
      where: { conversationId: created.body.id },
    })
    expect(participants).toHaveLength(3)
    expect(
      participants.find((participant) => participant.userId === owner.auth.user.id)?.role,
    ).toBe('OWNER')
    expect(participants.every((participant) => participant.joinedAtSeq === 0)).toBe(true)
    expect(
      participants.find((participant) => participant.userId === owner.auth.user.id)?.lastReadSeq,
    ).toBe(1)
    expect(
      participants
        .filter((participant) => participant.userId !== owner.auth.user.id)
        .every((participant) => participant.lastReadSeq === 0),
    ).toBe(true)

    const message = await prisma.message.findFirstOrThrow({
      where: { conversationId: created.body.id },
    })
    expect(message.metadata).toMatchObject({
      action: 'created',
      actorId: owner.auth.user.id,
      memberIds: [firstMember.auth.user.id, secondMember.auth.user.id],
    })

    const noOtherMembers = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'GROUP', name: 'Empty group', memberIds: [owner.auth.user.id] })
    expect(noOtherMembers.status).toBe(400)

    const tooManyMembers = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Too many members',
        memberIds: Array.from({ length: 256 }, () => randomUUID()),
      })
    expect(tooManyMembers.status).toBe(400)

    const unknownMember = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'GROUP', name: 'Unknown member', memberIds: [randomUUID()] })
    expect(unknownMember.status).toBe(404)
  })

  it('enforces rename permissions and sequences group system messages', async () => {
    const owner = await createRegisteredSession({ displayName: 'Owner' })
    const admin = await createRegisteredSession({ displayName: 'Admin' })
    const member = await createRegisteredSession({ displayName: 'Member' })
    const outsider = await createRegisteredSession({ displayName: 'Outsider' })
    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Initial name',
        memberIds: [admin.auth.user.id, member.auth.user.id],
      })
      .expect(201)

    await prisma.participant.update({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: admin.auth.user.id,
        },
      },
      data: { role: 'ADMIN' },
    })

    await request(app)
      .patch(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ name: 'Owner name' })
      .expect(200)
    await request(app)
      .patch(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${admin.auth.accessToken}`)
      .send({ name: 'Admin name' })
      .expect(200)

    const memberDenied = await request(app)
      .patch(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${member.auth.accessToken}`)
      .send({ name: 'Member name' })
    expect(memberDenied.status).toBe(403)

    const outsiderDenied = await request(app)
      .patch(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${outsider.auth.accessToken}`)
      .send({ name: 'Outsider name' })
    expect(outsiderDenied.status).toBe(404)

    const direct = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: outsider.auth.user.id })
      .expect(201)
    const directRename = await request(app)
      .patch(`/api/v1/conversations/${direct.body.id}`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ name: 'Invalid direct rename' })
    expect(directRename.status).toBe(400)

    const invalidName = await request(app)
      .patch(`/api/v1/conversations/${created.body.id}`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ name: ' ' })
    expect(invalidName.status).toBe(400)

    const messages = await prisma.message.findMany({
      where: { conversationId: created.body.id },
      orderBy: { seq: 'asc' },
    })
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3])
    expect(messages.map((message) => message.type)).toEqual(['SYSTEM', 'SYSTEM', 'SYSTEM'])
    expect(messages.map((message) => message.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'created' }),
        expect.objectContaining({ action: 'renamed', actorId: owner.auth.user.id }),
        expect.objectContaining({ action: 'renamed', actorId: admin.auth.user.id }),
      ]),
    )
  })

  it('adds and re-adds members with history watermarks and admin permissions', async () => {
    const owner = await createRegisteredSession({ displayName: 'Owner' })
    const admin = await createRegisteredSession({ displayName: 'Admin' })
    const member = await createRegisteredSession({ displayName: 'Member' })
    const returningMember = await createRegisteredSession({ displayName: 'Returning' })
    const newMember = await createRegisteredSession({ displayName: 'New Member' })
    const outsider = await createRegisteredSession({ displayName: 'Outsider' })
    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Members',
        memberIds: [admin.auth.user.id, member.auth.user.id, returningMember.auth.user.id],
      })
      .expect(201)

    await prisma.participant.update({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: admin.auth.user.id,
        },
      },
      data: { role: 'ADMIN' },
    })
    await prisma.participant.update({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: returningMember.auth.user.id,
        },
      },
      data: { leftAt: new Date() },
    })

    await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        userIds: [
          owner.auth.user.id,
          member.auth.user.id,
          newMember.auth.user.id,
          newMember.auth.user.id,
          returningMember.auth.user.id,
        ],
      })
      .expect(200)

    const newParticipant = await prisma.participant.findUniqueOrThrow({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: newMember.auth.user.id,
        },
      },
    })
    const rejoinedParticipant = await prisma.participant.findUniqueOrThrow({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: returningMember.auth.user.id,
        },
      },
    })
    expect(newParticipant.joinedAtSeq).toBe(1)
    expect(newParticipant.lastReadSeq).toBe(1)
    expect(rejoinedParticipant.leftAt).toBeNull()
    expect(rejoinedParticipant.joinedAtSeq).toBe(1)
    expect(
      (await prisma.conversation.findUniqueOrThrow({ where: { id: created.body.id } })).lastSeq,
    ).toBe(2)

    await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${admin.auth.accessToken}`)
      .send({ userIds: [member.auth.user.id] })
      .expect(200)
    expect(
      (await prisma.conversation.findUniqueOrThrow({ where: { id: created.body.id } })).lastSeq,
    ).toBe(2)

    const memberDenied = await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${member.auth.accessToken}`)
      .send({ userIds: [outsider.auth.user.id] })
    expect(memberDenied.status).toBe(403)

    const outsiderDenied = await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${outsider.auth.accessToken}`)
      .send({ userIds: [newMember.auth.user.id] })
    expect(outsiderDenied.status).toBe(404)

    const unknownUser = await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${admin.auth.accessToken}`)
      .send({ userIds: [randomUUID()] })
    expect(unknownUser.status).toBe(404)

    const direct = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: outsider.auth.user.id })
      .expect(201)
    const directAdd = await request(app)
      .post(`/api/v1/conversations/${direct.body.id}/members`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ userIds: [member.auth.user.id] })
    expect(directAdd.status).toBe(400)
  })

  it('enforces the 256 active-member group limit', async () => {
    const owner = await createRegisteredSession()
    const firstMember = await createRegisteredSession()
    const lastAllowedMember = await createRegisteredSession()
    const overflowMember = await createRegisteredSession()
    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Large group',
        memberIds: [firstMember.auth.user.id],
      })
      .expect(201)

    const seedPrefix = randomUUID().replaceAll('-', '').slice(0, 8)
    const filler = Array.from({ length: 253 }, (_, index) => {
      const suffix = String(index).padStart(3, '0')
      return {
        email: `fill-${seedPrefix}-${suffix}@example.com`,
        username: `fill_${seedPrefix}_${suffix}`,
        passwordHash: 'test-password-hash',
        displayName: `Filler ${suffix}`,
      }
    })
    await prisma.user.createMany({ data: filler })
    const fillerUsers = await prisma.user.findMany({
      where: { email: { in: filler.map((user) => user.email) } },
      select: { id: true },
    })
    await prisma.participant.createMany({
      data: fillerUsers.map(({ id }) => ({
        conversationId: created.body.id,
        userId: id,
      })),
    })

    await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ userIds: [lastAllowedMember.auth.user.id] })
      .expect(200)

    const overflow = await request(app)
      .post(`/api/v1/conversations/${created.body.id}/members`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ userIds: [overflowMember.auth.user.id] })
    expect(overflow.status).toBe(409)
    expect(overflow.body.error.code).toBe('CONFLICT')
    expect(await prisma.participant.count({ where: { conversationId: created.body.id } })).toBe(256)
  })

  it('enforces member-removal permissions and returns 400 for direct conversations', async () => {
    const owner = await createRegisteredSession()
    const admin = await createRegisteredSession()
    const secondAdmin = await createRegisteredSession()
    const member = await createRegisteredSession()
    const secondMember = await createRegisteredSession()
    const outsider = await createRegisteredSession()
    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Removal permissions',
        memberIds: [
          admin.auth.user.id,
          secondAdmin.auth.user.id,
          member.auth.user.id,
          secondMember.auth.user.id,
        ],
      })
      .expect(201)

    await prisma.participant.updateMany({
      where: {
        conversationId: created.body.id,
        userId: { in: [admin.auth.user.id, secondAdmin.auth.user.id] },
      },
      data: { role: 'ADMIN' },
    })

    const memberCannotRemoveAdmin = await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${secondAdmin.auth.user.id}`)
      .set('authorization', `Bearer ${member.auth.accessToken}`)
    expect(memberCannotRemoveAdmin.status).toBe(403)

    await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${secondMember.auth.user.id}`)
      .set('authorization', `Bearer ${admin.auth.accessToken}`)
      .expect(204)

    const adminCannotRemoveAdmin = await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${secondAdmin.auth.user.id}`)
      .set('authorization', `Bearer ${admin.auth.accessToken}`)
    expect(adminCannotRemoveAdmin.status).toBe(403)

    const adminCannotRemoveOwner = await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${owner.auth.user.id}`)
      .set('authorization', `Bearer ${admin.auth.accessToken}`)
    expect(adminCannotRemoveOwner.status).toBe(403)

    const outsiderCannotRemoveMember = await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${secondAdmin.auth.user.id}`)
      .set('authorization', `Bearer ${outsider.auth.accessToken}`)
    expect(outsiderCannotRemoveMember.status).toBe(404)

    await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${secondAdmin.auth.user.id}`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .expect(204)

    await request(app)
      .delete(`/api/v1/conversations/${created.body.id}/members/${member.auth.user.id}`)
      .set('authorization', `Bearer ${member.auth.accessToken}`)
      .expect(204)

    const direct = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: outsider.auth.user.id })
      .expect(201)
    const directRemoval = await request(app)
      .delete(`/api/v1/conversations/${direct.body.id}/members/${outsider.auth.user.id}`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
    expect(directRemoval.status).toBe(400)
  })

  it('transfers ownership on leave to the oldest admin or member', async () => {
    const owner = await createRegisteredSession({ displayName: 'Owner' })
    const oldestAdmin = await createRegisteredSession({ displayName: 'Oldest Admin' })
    const newerAdmin = await createRegisteredSession({ displayName: 'Newer Admin' })
    const member = await createRegisteredSession({ displayName: 'Member' })
    const outsider = await createRegisteredSession({ displayName: 'Outsider' })
    const created = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Ownership',
        memberIds: [oldestAdmin.auth.user.id, newerAdmin.auth.user.id, member.auth.user.id],
      })
      .expect(201)
    const baseTime = Date.now()
    await prisma.participant.updateMany({
      where: {
        conversationId: created.body.id,
        userId: { in: [oldestAdmin.auth.user.id, newerAdmin.auth.user.id] },
      },
      data: { role: 'ADMIN' },
    })
    await prisma.participant.update({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: oldestAdmin.auth.user.id,
        },
      },
      data: { joinedAt: new Date(baseTime - 2_000) },
    })
    await prisma.participant.update({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: newerAdmin.auth.user.id,
        },
      },
      data: { joinedAt: new Date(baseTime - 1_000) },
    })

    await request(app)
      .post(`/api/v1/conversations/${created.body.id}/leave`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .expect(204)
    const transferredOwner = await prisma.participant.findUniqueOrThrow({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: oldestAdmin.auth.user.id,
        },
      },
    })
    const formerOwner = await prisma.participant.findUniqueOrThrow({
      where: {
        conversationId_userId: {
          conversationId: created.body.id,
          userId: owner.auth.user.id,
        },
      },
    })
    expect(transferredOwner.role).toBe('OWNER')
    expect(formerOwner.role).toBe('MEMBER')
    expect(formerOwner.leftAt).not.toBeNull()

    await request(app)
      .post(`/api/v1/conversations/${created.body.id}/leave`)
      .set('authorization', `Bearer ${newerAdmin.auth.accessToken}`)
      .expect(204)
    const outsiderLeave = await request(app)
      .post(`/api/v1/conversations/${created.body.id}/leave`)
      .set('authorization', `Bearer ${outsider.auth.accessToken}`)
    expect(outsiderLeave.status).toBe(404)

    const noAdminOwner = await createRegisteredSession()
    const firstMember = await createRegisteredSession()
    const secondMember = await createRegisteredSession()
    const noAdminGroup = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${noAdminOwner.auth.accessToken}`)
      .send({
        type: 'GROUP',
        name: 'Member succession',
        memberIds: [firstMember.auth.user.id, secondMember.auth.user.id],
      })
      .expect(201)
    await prisma.participant.update({
      where: {
        conversationId_userId: {
          conversationId: noAdminGroup.body.id,
          userId: secondMember.auth.user.id,
        },
      },
      data: { joinedAt: new Date(Date.now() + 1_000) },
    })
    await request(app)
      .post(`/api/v1/conversations/${noAdminGroup.body.id}/leave`)
      .set('authorization', `Bearer ${noAdminOwner.auth.accessToken}`)
      .expect(204)
    expect(
      (
        await prisma.participant.findUniqueOrThrow({
          where: {
            conversationId_userId: {
              conversationId: noAdminGroup.body.id,
              userId: firstMember.auth.user.id,
            },
          },
        })
      ).role,
    ).toBe('OWNER')

    const direct = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${noAdminOwner.auth.accessToken}`)
      .send({ type: 'DIRECT', userId: outsider.auth.user.id })
      .expect(201)
    const directLeave = await request(app)
      .post(`/api/v1/conversations/${direct.body.id}/leave`)
      .set('authorization', `Bearer ${noAdminOwner.auth.accessToken}`)
    expect(directLeave.status).toBe(400)
  })

  it('calls the realtime gateway only after a group transaction commits', async () => {
    const owner = await createRegisteredSession()
    const member = await createRegisteredSession()
    const events: string[] = []
    const gateway = {
      toUser(userId: string, event: string) {
        events.push(`user:${userId}:${event}`)
      },
      toConversation(conversationId: string, event: string) {
        events.push(`conversation:${conversationId}:${event}`)
      },
      async joinUserToConversation(userId: string, conversationId: string) {
        const participant = await prisma.participant.findUnique({
          where: { conversationId_userId: { conversationId, userId } },
        })
        expect(participant).not.toBeNull()
        events.push(`join:${userId}`)
      },
      async removeUserFromConversation(userId: string, conversationId: string) {
        const participant = await prisma.participant.findUnique({
          where: { conversationId_userId: { conversationId, userId } },
        })
        expect(participant?.leftAt).not.toBeNull()
        events.push(`remove:${userId}`)
      },
    }
    const gatewayApp = createApp({
      gateway,
      rateLimits: { api: { limit: 1000, windowSeconds: 60 } },
    })

    const created = await request(gatewayApp)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'GROUP', name: 'Gateway', memberIds: [member.auth.user.id] })
      .expect(201)
    expect(events).toHaveLength(4)
    expect(events).toEqual(
      expect.arrayContaining([
        `join:${owner.auth.user.id}`,
        `user:${owner.auth.user.id}:conversation:created`,
        `join:${member.auth.user.id}`,
        `user:${member.auth.user.id}:conversation:created`,
      ]),
    )

    await request(gatewayApp)
      .delete(`/api/v1/conversations/${created.body.id}/members/${member.auth.user.id}`)
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .expect(204)
    expect(events.slice(-3)).toEqual([
      `remove:${member.auth.user.id}`,
      `user:${member.auth.user.id}:conversation:removed`,
      `conversation:${created.body.id}:conversation:updated`,
    ])
  })

  it('paginates active conversations by timestamp and id with viewer-specific state', async () => {
    const viewer = await createRegisteredSession()
    const peers = await Promise.all([
      createRegisteredSession(),
      createRegisteredSession(),
      createRegisteredSession(),
      createRegisteredSession(),
    ])
    const conversations = await Promise.all(
      peers.map(
        async (peer) =>
          (
            await request(app)
              .post('/api/v1/conversations')
              .set('authorization', `Bearer ${viewer.auth.accessToken}`)
              .send({ type: 'DIRECT', userId: peer.auth.user.id })
              .expect(201)
          ).body,
      ),
    )
    const [latest, tiedOne, tiedTwo, leftConversation] = conversations
    if (!latest || !tiedOne || !tiedTwo || !leftConversation) {
      throw new Error('Expected four direct conversations')
    }

    await Promise.all([
      prisma.conversation.update({
        where: { id: latest.id },
        data: { lastMessageAt: new Date('2030-01-03T00:00:00.000Z'), lastSeq: 5 },
      }),
      prisma.conversation.update({
        where: { id: tiedOne.id },
        data: { lastMessageAt: new Date('2030-01-02T00:00:00.000Z'), lastSeq: 6 },
      }),
      prisma.conversation.update({
        where: { id: tiedTwo.id },
        data: { lastMessageAt: new Date('2030-01-02T00:00:00.000Z'), lastSeq: 7 },
      }),
      prisma.conversation.update({
        where: { id: leftConversation.id },
        data: { lastMessageAt: new Date('2030-01-04T00:00:00.000Z'), lastSeq: 8 },
      }),
      prisma.participant.update({
        where: {
          conversationId_userId: {
            conversationId: leftConversation.id,
            userId: viewer.auth.user.id,
          },
        },
        data: { leftAt: new Date() },
      }),
      prisma.participant.update({
        where: {
          conversationId_userId: {
            conversationId: latest.id,
            userId: viewer.auth.user.id,
          },
        },
        data: { unreadCount: 4, lastReadSeq: 1 },
      }),
      prisma.participant.update({
        where: {
          conversationId_userId: {
            conversationId: tiedOne.id,
            userId: viewer.auth.user.id,
          },
        },
        data: { unreadCount: 2, lastReadSeq: 3 },
      }),
      prisma.participant.update({
        where: {
          conversationId_userId: {
            conversationId: tiedTwo.id,
            userId: viewer.auth.user.id,
          },
        },
        data: { unreadCount: 1, lastReadSeq: 2 },
      }),
    ])
    const deletedMessage = await prisma.message.create({
      data: {
        conversationId: latest.id,
        seq: 5,
        senderId: viewer.auth.user.id,
        content: 'Deleted content',
        clientMessageId: randomUUID(),
        deletedAt: new Date(),
      },
    })
    await prisma.conversation.update({
      where: { id: latest.id },
      data: { lastMessageId: deletedMessage.id },
    })

    const queryStart = observedQueries.length
    const firstPage = await request(app)
      .get('/api/v1/conversations?limit=2')
      .set('authorization', `Bearer ${viewer.auth.accessToken}`)
      .expect(200)
    const queryCount = observedQueries.length - queryStart
    expect(queryCount).toBeGreaterThan(0)
    expect(queryCount).toBeLessThanOrEqual(3)

    const tiedIds = [tiedOne.id, tiedTwo.id].sort().reverse()
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).toEqual([
      latest.id,
      tiedIds[0],
    ])
    expect(firstPage.body.items).toHaveLength(2)
    expect(firstPage.body.items[0]).toMatchObject({
      id: latest.id,
      lastSeq: 5,
      memberCount: 2,
      unreadCount: 4,
      myLastReadSeq: 1,
      lastMessage: { content: null, seq: 5 },
    })
    expect(firstPage.body.items[0].members).toEqual([
      expect.objectContaining({ userId: peers[0]?.auth.user.id }),
    ])
    expect(firstPage.body.nextCursor).toBeTypeOf('string')

    const secondPage = await request(app)
      .get(`/api/v1/conversations?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('authorization', `Bearer ${viewer.auth.accessToken}`)
      .expect(200)
    expect(secondPage.body.items.map((item: { id: string }) => item.id)).toEqual([tiedIds[1]])
    expect(secondPage.body.nextCursor).toBeNull()
    expect(
      [...firstPage.body.items, ...secondPage.body.items].some(
        (item: { id: string }) => item.id === leftConversation.id,
      ),
    ).toBe(false)

    const invalidCursor = await request(app)
      .get('/api/v1/conversations?cursor=not-valid!')
      .set('authorization', `Bearer ${viewer.auth.accessToken}`)
    expect(invalidCursor.status).toBe(400)
    expect(invalidCursor.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('limits group chat-list members to five while returning the full member count', async () => {
    const owner = await createRegisteredSession()
    const seedPrefix = randomUUID().replaceAll('-', '').slice(0, 8)
    const members = Array.from({ length: 6 }, (_, index) => {
      const suffix = String(index).padStart(2, '0')
      return {
        email: `list-${seedPrefix}-${suffix}@example.com`,
        username: `list_${seedPrefix}_${suffix}`,
        passwordHash: 'test-password-hash',
        displayName: `List Member ${suffix}`,
      }
    })
    await prisma.user.createMany({ data: members })
    const memberRows = await prisma.user.findMany({
      where: { email: { in: members.map((member) => member.email) } },
      select: { id: true },
    })
    const group = await request(app)
      .post('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .send({ type: 'GROUP', name: 'Chat list group', memberIds: memberRows.map(({ id }) => id) })
      .expect(201)

    const response = await request(app)
      .get('/api/v1/conversations')
      .set('authorization', `Bearer ${owner.auth.accessToken}`)
      .expect(200)

    expect(response.body.items).toHaveLength(1)
    expect(response.body.items[0]).toMatchObject({
      id: group.body.id,
      type: 'GROUP',
      memberCount: 7,
    })
    expect(response.body.items[0].members).toHaveLength(5)
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
