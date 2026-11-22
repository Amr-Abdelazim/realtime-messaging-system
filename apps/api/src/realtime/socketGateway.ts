import type { ServerToClientEvents } from '@realtime-messaging/contracts'

import type { RealtimeGateway } from './gateway.js'
import type { RealtimeServer } from './types.js'

type RealtimeEvent = keyof ServerToClientEvents
type RealtimeEventPayload<Event extends RealtimeEvent> = Parameters<ServerToClientEvents[Event]>[0]

export class SocketGateway implements RealtimeGateway {
  private io?: RealtimeServer

  constructor(io?: RealtimeServer) {
    this.io = io
  }

  attach(io: RealtimeServer): void {
    if (this.io) {
      throw new Error('Socket gateway is already attached')
    }
    this.io = io
  }

  toUser<Event extends RealtimeEvent>(
    userId: string,
    event: Event,
    payload: RealtimeEventPayload<Event>,
  ): void {
    const userRoom = this.getServer().to(`user:${userId}`)
    const emit = userRoom.emit.bind(userRoom) as <EmittedEvent extends RealtimeEvent>(
      emittedEvent: EmittedEvent,
      ...args: [RealtimeEventPayload<EmittedEvent>]
    ) => unknown
    emit(event, payload)
  }

  toConversation<Event extends RealtimeEvent>(
    conversationId: string,
    event: Event,
    payload: RealtimeEventPayload<Event>,
  ): void {
    const conversationRoom = this.getServer().to(`conv:${conversationId}`)
    const emit = conversationRoom.emit.bind(conversationRoom) as <
      EmittedEvent extends RealtimeEvent,
    >(
      emittedEvent: EmittedEvent,
      ...args: [RealtimeEventPayload<EmittedEvent>]
    ) => unknown
    emit(event, payload)
  }

  async joinUserToConversation(userId: string, conversationId: string): Promise<void> {
    await this.getServer().in(`user:${userId}`).socketsJoin(`conv:${conversationId}`)
  }

  async removeUserFromConversation(userId: string, conversationId: string): Promise<void> {
    await this.getServer().in(`user:${userId}`).socketsLeave(`conv:${conversationId}`)
  }

  private getServer(): RealtimeServer {
    if (!this.io) {
      throw new Error('Socket gateway is not attached to a realtime server')
    }
    return this.io
  }
}
