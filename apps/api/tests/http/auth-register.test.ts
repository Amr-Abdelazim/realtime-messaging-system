import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'
import { jwtVerify } from 'jose'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { AuthResponse } from '@realtime-messaging/contracts'
import { env } from '../../src/config/env.js'
import { createApp } from '../../src/http/app.js'
import { REFRESH_COOKIE_NAME } from '../../src/modules/auth/cookies.js'
import { hashRefreshToken } from '../../src/modules/auth/tokens.js'
import { disconnectDb, resetDb } from '../helpers/db.js'

const app = createApp()
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

describe.skipIf(process.env.CI !== 'true')('POST /api/v1/auth/register', () => {
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
})
