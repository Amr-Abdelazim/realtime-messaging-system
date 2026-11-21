import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType } from 'zod'

import { ValidationError } from '../errors/index.js'

type ValidationSchemas = {
  body?: ZodType
  query?: ZodType
  params?: ZodType
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sources = [
      ['body', req.body, schemas.body],
      ['query', req.query, schemas.query],
      ['params', req.params, schemas.params],
    ] as const

    try {
      for (const [source, value, schema] of sources) {
        if (!schema) {
          continue
        }

        const result = schema.safeParse(value)
        if (!result.success) {
          const details = result.error.issues.map((issue) => ({
            path: issue.path.length > 0 ? issue.path.join('.') : source,
            message: issue.message,
          }))
          throw new ValidationError('Invalid request', details)
        }

        if (source === 'body') {
          req.body = result.data
        } else if (source === 'query') {
          req.query = result.data as Request['query']
        } else {
          req.params = result.data as Request['params']
        }
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}
