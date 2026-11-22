import type { ZodType } from 'zod'

import { AppError } from '../http/errors/app-error.js'
import { logger } from '../infra/logger.js'
import type { ClientToServerEvents, SocketAck } from '@realtime-messaging/contracts'
import type { RealtimeSocket } from './types.js'

type AckListener<Data> = (response: SocketAck<Data>) => void
type IncomingListener<Data> = (payload?: unknown, ack?: AckListener<Data>) => void

export function handle<Payload, Data>(
  socket: RealtimeSocket,
  event: keyof ClientToServerEvents,
  schema: ZodType<Payload>,
  fn: (payload: Payload) => Data | Promise<Data>,
): void {
  const listener: IncomingListener<Data> = async (payload, ack) => {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      ack?.({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request' },
      })
      return
    }

    try {
      const data = await fn(parsed.data)
      ack?.({ ok: true, data })
    } catch (error) {
      if (error instanceof AppError) {
        ack?.({ ok: false, error: { code: error.code, message: error.message } })
        return
      }

      logger.error(
        { err: error, socketId: socket.id, userId: socket.data.userId, event },
        'Unexpected socket handler error',
      )
      ack?.({
        ok: false,
        error: { code: 'INTERNAL', message: 'Internal server error' },
      })
    }
  }

  const register = socket.on.bind(socket) as (
    event: keyof ClientToServerEvents,
    listener: IncomingListener<Data>,
  ) => RealtimeSocket
  register(event, listener)
}
