import type { RequestHandler } from 'express'

import { RateLimitedError } from '../errors/index.js'
import { rateLimit } from '../../infra/rateLimit.js'

export function limitByIp(name: string, limit: number, windowSeconds: number): RequestHandler {
  return async (req, _res, next) => {
    const result = await rateLimit({
      key: `rate-limit:${name}:${req.ip}`,
      limit,
      windowSeconds,
    })

    if (!result.allowed) {
      next(new RateLimitedError('Too many requests', result.retryAfterSeconds))
      return
    }

    next()
  }
}
