import { z } from 'zod'

import dotenv from 'dotenv'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

dotenv.config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
})

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    PORT: z.coerce.number().int().positive().default(3000),
    TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
    INSTANCE_ID: z.string().min(1).default(hostname()),

    DATABASE_URL: z.string().url(),

    DATABASE_URL_TEST: z.string().url(),

    REDIS_URL: z.string().url(),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('debug'),
  })
  .transform(({ COOKIE_SECURE, ...config }) => ({
    ...config,
    COOKIE_SECURE:
      COOKIE_SECURE === undefined ? config.NODE_ENV === 'production' : COOKIE_SECURE === 'true',
  }))

function validateEnv() {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    console.error('Invalid environment configuration:')

    for (const issue of result.error.issues) {
      console.error(`- ${issue.path.join('.')}: ${issue.message}`)
    }

    process.exit(1)
  }

  return result.data
}

export const env = validateEnv()
