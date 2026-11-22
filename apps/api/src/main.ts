import { createServer } from 'node:http'

import { env } from './config/env.js'
import { createApp } from './http/app.js'
import { logger } from './infra/logger.js'
import { SocketGateway } from './realtime/socketGateway.js'
import { createRealtimeServer } from './realtime/server.js'

const gateway = new SocketGateway()
const app = createApp({ gateway })
const httpServer = createServer(app)
const realtimeServer = createRealtimeServer(httpServer)
gateway.attach(realtimeServer)

httpServer.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'API server started')
})
