import { Router, type Router as ExpressRouter } from 'express'
import { env } from '../../config/env.js'

const router: ExpressRouter = Router()

const startTime = process.hrtime.bigint()

router.get('/health', (_req, res) => {
  const uptime = Number(process.hrtime.bigint() - startTime) / 1_000_000_000

  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(uptime),
    instanceId: env.INSTANCE_ID,
  })
})

export default router
