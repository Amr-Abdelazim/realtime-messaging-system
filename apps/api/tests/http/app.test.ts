import { describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import { z } from 'zod'

import { createApp } from '../../src/http/app.js'
import { validate } from '../../src/http/middleware/validate.js'
import { errorHandler } from '../../src/http/middleware/error-handler.js'
import { notFoundHandler } from '../../src/http/middleware/not-found.js'
import { env } from '../../src/config/env.js'

describe('HTTP application', () => {
  const app = createApp()

  it('GET /health should return 200', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    expect(response.body.uptime).toBeTypeOf('number')
    expect(response.body.instanceId).toBe(env.INSTANCE_ID)
  })

  it('should return 404 for unknown routes', async () => {
    const response = await request(app).get('/unknown')

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.requestId).toBeDefined()
  })

  it('should validate request bodies and return field details', async () => {
    const validationApp = express()
    validationApp.use(express.json())
    validationApp.post(
      '/test',
      validate({
        body: z.object({
          email: z.string().email(),
          name: z.string().min(2),
        }),
      }),
      (req, res) => {
        res.status(200).json(req.body)
      },
    )
    validationApp.use(notFoundHandler)
    validationApp.use(errorHandler)

    const invalid = await request(validationApp).post('/test').send({
      email: 'invalid',
      name: 'A',
    })

    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR')
    expect(invalid.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'name' }),
      ]),
    )

    const valid = await request(validationApp).post('/test').send({
      email: 'test@example.com',
      name: 'Ada',
    })
    expect(valid.status).toBe(200)
    expect(valid.body).toEqual({
      email: 'test@example.com',
      name: 'Ada',
    })
  })

  it('should return a readiness response', async () => {
    const response = await request(app).get('/ready')

    expect([200, 503]).toContain(response.status)
    expect(['ready', 'not_ready']).toContain(response.body.status)
  })
})
