import express, { type Express } from 'express'
import helmet from 'helmet'
import cors from 'cors'

import { env } from '../config/env.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { requestLogger } from './middleware/request-logger.js'
import { notFoundHandler } from './middleware/not-found.js'
import { errorHandler } from './middleware/error-handler.js'
import healthRouter from './routes/health.js'
import readyRouter from './routes/ready.js'

export function createApp(): Express {
  const app = express()

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

  // Body parsing
  app.use(express.json({ limit: '100kb' }))

  // Routes will go here
  app.use(healthRouter)
  app.use(readyRouter)
  // Error handling (must remain last)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
