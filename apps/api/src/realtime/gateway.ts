export interface RealtimeGateway {
  toUser(userId: string, event: string, payload: unknown): void
  toConversation(conversationId: string, event: string, payload: unknown): void
  joinUserToConversation(userId: string, conversationId: string): void | Promise<void>
  removeUserFromConversation(userId: string, conversationId: string): void | Promise<void>
}

export class NoopGateway implements RealtimeGateway {
  toUser(_userId: string, _event: string, _payload: unknown): void {}

  toConversation(_conversationId: string, _event: string, _payload: unknown): void {}

  joinUserToConversation(_userId: string, _conversationId: string): void {}

  removeUserFromConversation(_userId: string, _conversationId: string): void {}
}
