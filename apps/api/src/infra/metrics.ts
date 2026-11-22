import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client'

import { env } from '../config/env.js'

export const metricsRegistry = new Registry()
metricsRegistry.setDefaultLabels({ instanceId: env.INSTANCE_ID })

export const socketsConnected = new Gauge({
  name: 'sockets_connected',
  help: 'Number of connected sockets on this API instance',
  registers: [metricsRegistry],
})

export const messagesSent = new Counter({
  name: 'messages_sent_total',
  help: 'Number of non-duplicate messages sent by this API instance',
  registers: [metricsRegistry],
})

export const socketAckErrors = new Counter({
  name: 'socket_ack_errors_total',
  help: 'Number of failed socket acknowledgements on this API instance',
  registers: [metricsRegistry],
})

export const rateLimited = new Counter({
  name: 'rate_limited_total',
  help: 'Number of requests rejected by rate limiting on this API instance',
  registers: [metricsRegistry],
})

export const messageSendDuration = new Histogram({
  name: 'message_send_duration_seconds',
  help: 'Time spent processing message send events',
  registers: [metricsRegistry],
})

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Time spent processing HTTP requests',
  labelNames: ['method', 'status_code'],
  registers: [metricsRegistry],
})
