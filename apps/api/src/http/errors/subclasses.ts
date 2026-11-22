import { ErrorCode } from '@realtime-messaging/contracts'
import { AppError } from './app-error.js'

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.VALIDATION_ERROR, 400, message, details)
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(ErrorCode.UNAUTHENTICATED, 401, message)
  }
}

export class TokenExpiredError extends AppError {
  constructor(message = 'Access token expired') {
    super(ErrorCode.TOKEN_EXPIRED, 401, message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super(ErrorCode.FORBIDDEN, 403, message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(ErrorCode.NOT_FOUND, 404, message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.CONFLICT, 409, message, details)
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message = 'Too many requests',
    public readonly retryAfterSeconds?: number,
  ) {
    super(ErrorCode.RATE_LIMITED, 429, message)
  }
}
