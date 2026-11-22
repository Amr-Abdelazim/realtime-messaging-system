import type { RequestHandler } from 'express'

import { httpRequestDuration } from '../../infra/metrics.js'
import { logger } from '../../infra/logger.js'

export const requestLogger: RequestHandler = (req, res, next) => {
  const startTime = process.hrtime.bigint()

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1_000_000_000
    const durationMs = durationSeconds * 1000
    httpRequestDuration.observe(
      { method: req.method, status_code: String(res.statusCode) },
      durationSeconds,
    )

    logger.info(
      {
        requestId: res.locals.requestId,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      },
      'Request completed',
    )
  })

  next()
}
