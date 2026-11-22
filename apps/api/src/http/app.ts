import express, { type Express } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'

import { env } from '../config/env.js'
import { limitByIp } from './middleware/limitByIp.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { requestLogger } from './middleware/request-logger.js'
import { notFoundHandler } from './middleware/not-found.js'
import { errorHandler } from './middleware/error-handler.js'
import healthRouter from './routes/health.js'
import readyRouter from './routes/ready.js'
import { createAuthRouter } from './routes/auth.js'
import usersRouter from './routes/users.js'
import type { RateLimitPolicy } from '../infra/rateLimit.js'

export type AppOptions = {
  trustProxy?: number
  rateLimits?: {
    api?: RateLimitPolicy
    register?: RateLimitPolicy
    login?: RateLimitPolicy
    loginFailures?: RateLimitPolicy
  }
}

const defaultRateLimits = {
  api: { limit: 100, windowSeconds: 60 },
  register: { limit: 10, windowSeconds: 60 },
  login: { limit: 10, windowSeconds: 60 },
  loginFailures: { limit: 5, windowSeconds: 15 * 60 },
}

function validateLimitPolicy(name: string, policy: RateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1) {
    throw new RangeError(`${name} limit must be a positive integer`)
  }
  if (!Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
    throw new RangeError(`${name} window must be a positive integer`)
  }
}

export function createApp(options: AppOptions = {}): Express {
  const rateLimits = {
    api: options.rateLimits?.api ?? defaultRateLimits.api,
    register: options.rateLimits?.register ?? defaultRateLimits.register,
    login: options.rateLimits?.login ?? defaultRateLimits.login,
    loginFailures: options.rateLimits?.loginFailures ?? defaultRateLimits.loginFailures,
  }
  for (const [name, policy] of Object.entries(rateLimits)) {
    validateLimitPolicy(name, policy)
  }

  const trustProxy = options.trustProxy ?? env.TRUST_PROXY
  if (!Number.isSafeInteger(trustProxy) || trustProxy < 0) {
    throw new RangeError('Trust proxy must be a non-negative integer')
  }

  const app = express()
  app.set('trust proxy', trustProxy)

  // Request infrastructure
  app.use(requestIdMiddleware)
  app.use(requestLogger)

  // Security
  app.use(helmet())

  // CORS
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim())

  app.use(
    cors({
      origin: allowedOrigins,
    }),
  )

  app.use('/api/v1', limitByIp('api', rateLimits.api.limit, rateLimits.api.windowSeconds))
  app.post(
    '/api/v1/auth/register',
    limitByIp('register', rateLimits.register.limit, rateLimits.register.windowSeconds),
  )
  app.post(
    '/api/v1/auth/login',
    limitByIp('login', rateLimits.login.limit, rateLimits.login.windowSeconds),
  )

  // Body parsing
  app.use(express.json({ limit: '100kb' }))
  app.use(cookieParser())

  // Routes will go here
  app.use(healthRouter)
  app.use(readyRouter)
  app.use(
    '/api/v1',
    createAuthRouter({
      loginFailures: rateLimits.loginFailures,
    }),
  )
  app.use('/api/v1', usersRouter)
  // Error handling (must remain last)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
