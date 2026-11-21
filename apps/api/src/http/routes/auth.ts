import { Router, type RequestHandler, type Router as ExpressRouter } from 'express'
import { LoginBody, RegisterBody } from '@realtime-messaging/contracts'

import { validate } from '../middleware/validate.js'
import { setRefreshCookie } from '../../modules/auth/cookies.js'
import { login, register } from '../../modules/auth/auth.service.js'

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
  const result = await login(LoginBody.parse(req.body), {
    userAgent: req.get('user-agent') ?? null,
    ip: req.ip ?? null,
  })

  setRefreshCookie(res, result.refreshToken)
  res.status(200).json({
    user: result.user,
    accessToken: result.accessToken,
  })
}

router.post('/auth/login', validate({ body: LoginBody }), loginHandler)

export default router
