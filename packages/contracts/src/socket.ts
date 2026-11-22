import type { ConversationDto, MessageDto } from './conversations.js'

export type SocketAck<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export type SendMessageAck = { message: MessageDto; duplicate: boolean }

export interface ClientToServerEvents {
  'message:send': (
    payload: {
      conversationId: string
      clientMessageId: string
      content: string
      replyToId?: string
    },
    ack: (response: SocketAck<SendMessageAck>) => void,
  ) => void
  'message:delete': (
    payload: { messageId: string },
    ack: (response: SocketAck<{ messageId: string; seq: number }>) => void,
  ) => void
  'message:delivered': (
    payload: { conversationId: string; upToSeq: number },
    ack: (response: SocketAck<Record<string, never>>) => void,
  ) => void
  'conversation:read': (
    payload: { conversationId: string; upToSeq: number },
    ack: (response: SocketAck<{ unreadCount: number }>) => void,
  ) => void
  'typing:start': (payload: { conversationId: string }) => void
  'typing:stop': (payload: { conversationId: string }) => void
  'presence:ping': () => void
}

export interface ServerToClientEvents {
  ready: (payload: { serverTime: string }) => void
  'message:new': (payload: { message: MessageDto }) => void
  'message:deleted': (payload: { conversationId: string; messageId: string; seq: number }) => void
  'message:status': (payload: {
    conversationId: string
    userId: string
    kind: 'delivered' | 'read'
    upToSeq: number
  }) => void
  'conversation:created': (payload: { conversation: ConversationDto }) => void
  'conversation:updated': (payload: { conversation: ConversationDto }) => void
  'conversation:removed': (payload: { conversationId: string }) => void
  typing: (payload: { conversationId: string; userId: string; isTyping: boolean }) => void
  'presence:update': (payload: {
    userId: string
    online: boolean
    lastSeenAt: string | null
  }) => void
  rate_limited: (payload: { event: string; retryAfterMs: number }) => void
}
