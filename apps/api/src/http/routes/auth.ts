import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'
import { LoginBody, RegisterBody } from '@realtime-messaging/contracts'

import { validate } from '../middleware/validate.js'
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from '../../modules/auth/cookies.js'
import { login, register } from '../../modules/auth/auth.service.js'
import { UnauthenticatedError } from '../errors/index.js'
import { logoutRefreshSession, rotateRefreshSession } from '../../modules/auth/sessions.js'
import type { RateLimitPolicy } from '../../infra/rateLimit.js'

type AuthRouterOptions = {
  loginFailures: RateLimitPolicy
}

export function createAuthRouter(options: AuthRouterOptions): ExpressRouter {
  const router: ExpressRouter = Router()

  const registerHandler: RequestHandler = async (req, res) => {
    const result = await register(RegisterBody.parse(req.body), {
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    })

    setRefreshCookie(res, result.refreshToken)
    res.status(201).json({
      user: result.user,
      accessToken: result.accessToken,
    })
  }

  router.post('/auth/register', validate({ body: RegisterBody }), registerHandler)

  const loginHandler: RequestHandler = async (req, res) => {
    const result = await login(
      LoginBody.parse(req.body),
      {
        userAgent: req.get('user-agent') ?? null,
        ip: req.ip ?? null,
      },
      options.loginFailures,
    )

    setRefreshCookie(res, result.refreshToken)
    res.status(200).json({
      user: result.user,
      accessToken: result.accessToken,
    })
  }

  router.post('/auth/login', validate({ body: LoginBody }), loginHandler)

  const refreshHandler: RequestHandler = async (req, res, next) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME]
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      clearRefreshCookie(res)
      next(new UnauthenticatedError('Invalid refresh token'))
      return
    }

    const result = await rotateRefreshSession(refreshToken, {
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    })
    if (!result) {
      clearRefreshCookie(res)
      next(new UnauthenticatedError('Invalid refresh token'))
      return
    }

    setRefreshCookie(res, result.refreshToken)
    res.status(200).json({ accessToken: result.accessToken })
  }

  router.post('/auth/refresh', refreshHandler)

  const logoutHandler: RequestHandler = async (req, res) => {
    try {
      const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME]
      await logoutRefreshSession(typeof refreshToken === 'string' ? refreshToken : undefined)
    } finally {
      clearRefreshCookie(res)
    }

    res.status(204).end()
  }

  router.post('/auth/logout', logoutHandler)

  return router
}
