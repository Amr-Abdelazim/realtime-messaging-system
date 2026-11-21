import type { Response } from 'express'

import { env } from '../../config/env.js'

export const REFRESH_COOKIE_NAME = 'refreshToken'
const REFRESH_COOKIE_PATH = '/api/v1/auth'

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  }
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions())
}

export function clearRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions()
  res.clearCookie(REFRESH_COOKIE_NAME, options)
}
