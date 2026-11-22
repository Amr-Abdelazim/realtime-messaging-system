import type { ServerToClientEvents } from '@realtime-messaging/contracts'

type RealtimeEvent = keyof ServerToClientEvents
type RealtimeEventPayload<Event extends RealtimeEvent> = Parameters<ServerToClientEvents[Event]>[0]

export interface RealtimeGateway {
  toUser<Event extends RealtimeEvent>(
    userId: string,
    event: Event,
    payload: RealtimeEventPayload<Event>,
  ): void
  toConversation<Event extends RealtimeEvent>(
    conversationId: string,
    event: Event,
    payload: RealtimeEventPayload<Event>,
  ): void
  joinUserToConversation(userId: string, conversationId: string): void | Promise<void>
  removeUserFromConversation(userId: string, conversationId: string): void | Promise<void>
}

export class NoopGateway implements RealtimeGateway {
  toUser<Event extends RealtimeEvent>(
    _userId: string,
    _event: Event,
    _payload: RealtimeEventPayload<Event>,
  ): void {}

  toConversation<Event extends RealtimeEvent>(
    _conversationId: string,
    _event: Event,
    _payload: RealtimeEventPayload<Event>,
  ): void {}

  joinUserToConversation(_userId: string, _conversationId: string): void {}

  removeUserFromConversation(_userId: string, _conversationId: string): void {}
}
