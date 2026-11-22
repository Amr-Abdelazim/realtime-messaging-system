import type { ClientToServerEvents, ServerToClientEvents } from '@realtime-messaging/contracts'
import type { DefaultEventsMap, Server, Socket } from 'socket.io'

export type SocketData = {
  userId: string
  sessionId: string
  tokenExp: number
}

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>

export type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>
