import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ErrorCode, ErrorEnvelope, IdSchema, IsoDateSchema, PaginationQuery } from '../src/index.js'

describe('shared contracts', () => {
  it('validates ids and ISO timestamps', () => {
    expect(IdSchema.safeParse('user-123').success).toBe(true)
    expect(IdSchema.safeParse('').success).toBe(false)
    expect(IsoDateSchema.safeParse('2026-11-21T23:48:30.884Z').success).toBe(true)
  })

  it('coerces and bounds pagination limits', () => {
    expect(PaginationQuery.parse({ limit: '20' })).toEqual({ limit: 20 })
    expect(PaginationQuery.parse({})).toEqual({ limit: 30 })
    expect(PaginationQuery.safeParse({ limit: 101 }).success).toBe(false)
  })

  it('defines the error envelope', () => {
    const envelope = {
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid request',
        details: [{ path: 'email', message: 'Invalid email' }],
      },
    }

    expect(ErrorEnvelope.parse(envelope)).toEqual(envelope)
    expect(
      ErrorEnvelope.safeParse({
        error: {
          code: ErrorCode.INTERNAL,
          message: 'Internal server error',
          details: null,
        },
      }).success,
    ).toBe(true)
  })

  it('can be composed with package schemas', () => {
    const schema = z.object({ id: IdSchema })
    expect(schema.parse({ id: '123' })).toEqual({ id: '123' })
  })
})
