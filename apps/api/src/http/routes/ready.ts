import { Router, type Router as ExpressRouter } from 'express'

import { prisma } from '../../infra/prisma.js'
import { redis } from '../../infra/redis.js'

const router: ExpressRouter = Router()

router.get('/ready', async (_req, res) => {
  const checks = {
    postgres: false,
    redis: false,
  }

  try {
    await prisma.$queryRaw`SELECT 1`
    checks.postgres = true
  } catch {
    checks.postgres = false
  }

  try {
    await redis.ping()
    checks.redis = true
  } catch {
    checks.redis = false
  }

  if (checks.postgres && checks.redis) {
    res.status(200).json({ status: 'ready' })
    return
  }

  res.status(503).json({ status: 'not_ready', checks })
})

export default router
