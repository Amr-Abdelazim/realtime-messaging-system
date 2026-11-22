import type { ErrorRequestHandler } from 'express'
import { ErrorCode } from '@realtime-messaging/contracts'
import { AppError, RateLimitedError } from '../errors/index.js'
import { logger } from '../../infra/logger.js'

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isOperational = err instanceof AppError

  const status = isOperational ? err.status : 500
  const code = isOperational ? err.code : ErrorCode.INTERNAL
  const message = isOperational ? err.message : 'Internal server error'

  if (err instanceof RateLimitedError && err.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds))
  }

  if (isOperational) {
    logger.warn(
      {
        err,
        requestId: res.locals.requestId,
      },
      'Request failed',
    )
  } else {
    logger.error(
      {
        err,
        requestId: res.locals.requestId,
      },
      'Unexpected server error',
    )
  }

  res.status(status).json({
    error: {
      code,
      message,
      details: isOperational ? (err.details ?? null) : null,
      requestId: res.locals.requestId,
    },
  })
}
