import type { MessageDto } from '@realtime-messaging/contracts'

export type OutboxStatus = 'pending' | 'sent' | 'failed'

export type OutboxMessage = {
  clientMessageId: string
  conversationId: string
  content: string
  replyToId?: string
  createdAt: string
  status: OutboxStatus
  message?: MessageDto
  error?: string
}

export interface ChatStorage {
  getLastSeq(conversationId: string): number | Promise<number>
  setLastSeq(conversationId: string, seq: number): void | Promise<void>
  getOutbox(): OutboxMessage[] | Promise<OutboxMessage[]>
  setOutbox(messages: OutboxMessage[]): void | Promise<void>
}

export function createMemoryStorage(): ChatStorage {
  const lastSeqByConversation = new Map<string, number>()
  let outbox: OutboxMessage[] = []

  return {
    getLastSeq(conversationId) {
      return lastSeqByConversation.get(conversationId) ?? 0
    },
    setLastSeq(conversationId, seq) {
      lastSeqByConversation.set(
        conversationId,
        Math.max(lastSeqByConversation.get(conversationId) ?? 0, seq),
      )
    },
    getOutbox() {
      return outbox.map((message) => ({ ...message }))
    },
    setOutbox(messages) {
      outbox = messages.map((message) => ({ ...message }))
    },
  }
}
