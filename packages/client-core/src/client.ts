import {
  ConversationListResponse,
  MessageHistoryResponse,
  SendMessageInput,
  type ClientToServerEvents,
  type ConversationDto,
  type MessageDto,
  type SendMessageAck,
  type ServerToClientEvents,
  type SocketAck,
} from '@realtime-messaging/contracts'
import { io, type Socket } from 'socket.io-client'

import { TypedEventEmitter } from './events.js'
import { createMemoryStorage, type ChatStorage, type OutboxMessage } from './storage.js'
import { detectGap, mergeMessages } from './sync.js'

const ACK_TIMEOUT_MS = 5_000
const RETRY_LIMIT = 5
const RETRY_BASE_DELAY_MS = 500
const PRESENCE_HEARTBEAT_MS = 25_000

type ServerPayloads = {
  [Event in keyof ServerToClientEvents]: Parameters<ServerToClientEvents[Event]>[0]
}

export type ChatClientEvents = ServerPayloads & {
  connect: undefined
  disconnect: string
  connect_error: Error
  'client:error': Error
  'sync:complete': { messages: MessageDto[] }
  'messages:sync': { conversationId: string; messages: MessageDto[] }
  'outbox:update': OutboxMessage
}

export type ChatClientOptions = {
  baseUrl: string
  getAccessToken: () => string | Promise<string>
  refreshAccessToken: () => Promise<string>
  storage?: ChatStorage
}

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>

type ConversationSync = {
  targetSeq: number
  promise: Promise<MessageDto[]>
}

export class ChatClient {
  private readonly baseUrl: string
  private readonly getAccessToken: ChatClientOptions['getAccessToken']
  private readonly refreshAccessToken: ChatClientOptions['refreshAccessToken']
  private readonly storage: ChatStorage
  private readonly socket: TypedSocket
  private readonly events = new TypedEventEmitter<ChatClientEvents>()
  private readonly conversationSyncs = new Map<string, ConversationSync>()
  private readonly sequenceWrites = new Map<string, Promise<void>>()
  private readonly incomingQueues = new Map<string, Promise<void>>()
  private readonly inFlightSends = new Map<string, Promise<OutboxMessage>>()
  private outbox: OutboxMessage[] = []
  private outboxLoaded: Promise<void> | null = null
  private outboxWrite: Promise<void> = Promise.resolve()
  private syncAllPromise: Promise<MessageDto[]> | null = null
  private flushPromise: Promise<void> | null = null
  private refreshPromise: Promise<void> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private ready = false
  private connecting = false
  private closed = false

  constructor(options: ChatClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.getAccessToken = options.getAccessToken
    this.refreshAccessToken = options.refreshAccessToken
    this.storage = options.storage ?? createMemoryStorage()
    this.socket = io(new URL(this.baseUrl).origin, {
      autoConnect: false,
      auth: {},
      reconnection: true,
      reconnectionDelay: RETRY_BASE_DELAY_MS,
      reconnectionDelayMax: 5_000,
      transports: ['websocket'],
    })

    this.bindSocketEvents()
    this.heartbeat = setInterval(() => {
      if (this.socket.connected) {
        this.socket.emit('presence:ping')
      }
    }, PRESENCE_HEARTBEAT_MS)
  }

  on<Event extends keyof ChatClientEvents>(
    event: Event,
    listener: (payload: ChatClientEvents[Event]) => void,
  ): () => void {
    return this.events.on(event, listener)
  }

  onAny(listener: Parameters<TypedSocket['onAny']>[0]): () => void {
    this.socket.onAny(listener)
    return () => this.socket.offAny(listener)
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('ChatClient has been closed')
    }
    if (this.socket.connected || this.connecting) {
      return
    }

    this.connecting = true
    try {
      const token = await this.getAccessToken()
      this.setSocketToken(token)
      this.socket.io.reconnection(true)
      this.socket.connect()
    } catch (error) {
      this.connecting = false
      throw error
    }
  }

  async reconnect(): Promise<void> {
    this.socket.disconnect()
    await this.connect()
  }

  disconnect(): void {
    this.ready = false
    this.connecting = false
    this.socket.disconnect()
  }

  close(): void {
    this.closed = true
    this.disconnect()
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    this.socket.removeAllListeners()
    this.socket.io.removeAllListeners()
  }

  async send(conversationId: string, content: string, replyToId?: string): Promise<OutboxMessage> {
    const input = SendMessageInput.parse({
      conversationId,
      clientMessageId: globalThis.crypto.randomUUID(),
      content,
      ...(replyToId ? { replyToId } : {}),
    })
    await this.ensureOutboxLoaded()
    const message: OutboxMessage = {
      ...input,
      createdAt: new Date().toISOString(),
      status: 'pending',
    }
    this.outbox.push(message)
    await this.persistOutbox()
    this.events.emit('outbox:update', { ...message })
    if (!this.ready) {
      return { ...message }
    }
    return this.sendPending(message.clientMessageId)
  }

  async retry(clientMessageId: string): Promise<OutboxMessage> {
    await this.ensureOutboxLoaded()
    const message = this.outbox.find((item) => item.clientMessageId === clientMessageId)
    if (!message) {
      throw new Error(`Outbox message ${clientMessageId} was not found`)
    }
    if (message.status === 'sent') {
      return { ...message }
    }

    const pending = await this.updateOutbox(clientMessageId, {
      status: 'pending',
      error: undefined,
    })
    if (!this.ready) {
      return pending
    }
    return this.sendPending(clientMessageId)
  }

  async getOutbox(): Promise<OutboxMessage[]> {
    await this.ensureOutboxLoaded()
    return this.outbox.map((message) => ({ ...message }))
  }

  async syncAll(): Promise<MessageDto[]> {
    if (this.syncAllPromise) {
      return this.syncAllPromise
    }

    const sync = this.runSyncAll()
    this.syncAllPromise = sync
    void sync.then(
      () => {
        if (this.syncAllPromise === sync) {
          this.syncAllPromise = null
        }
      },
      () => {
        if (this.syncAllPromise === sync) {
          this.syncAllPromise = null
        }
      },
    )
    return sync
  }

  async markDelivered(conversationId: string, upToSeq: number): Promise<void> {
    const ack = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('message:delivered', {
      conversationId,
      upToSeq,
    })
    this.assertAck(ack)
  }

  async markRead(conversationId: string, upToSeq: number): Promise<{ unreadCount: number }> {
    const ack = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('conversation:read', {
      conversationId,
      upToSeq,
    })
    if (!ack.ok) {
      throw new Error(ack.error.message)
    }
    return ack.data
  }

  setTyping(conversationId: string, isTyping: boolean): void {
    this.socket.emit(isTyping ? 'typing:start' : 'typing:stop', { conversationId })
  }

  private bindSocketEvents(): void {
    this.socket.on('connect', () => {
      this.connecting = false
      this.events.emit('connect', undefined)
    })
    this.socket.on('connect_error', (error) => {
      this.connecting = false
      this.events.emit('connect_error', error)
      if (error.message === 'TOKEN_EXPIRED') {
        void this.refreshExpiredToken().catch((refreshError: unknown) => {
          this.reportError(refreshError)
        })
      }
    })
    this.socket.on('disconnect', (reason) => {
      this.ready = false
      this.events.emit('disconnect', reason)
      if (reason === 'io server disconnect' && !this.closed) {
        void this.connect().catch((error: unknown) => this.reportError(error))
      }
    })
    this.socket.on('ready', (payload) => {
      this.ready = true
      this.events.emit('ready', payload)
      void this.syncAll()
        .then((messages) => this.events.emit('sync:complete', { messages }))
        .catch((error: unknown) => this.reportError(error))
      void this.flushOutbox().catch((error: unknown) => this.reportError(error))
    })
    this.socket.on('message:new', ({ message }) => {
      this.queueIncomingMessage(message)
    })
    this.socket.on('message:deleted', (payload) => this.events.emit('message:deleted', payload))
    this.socket.on('message:status', (payload) => this.events.emit('message:status', payload))
    this.socket.on('conversation:created', (payload) =>
      this.events.emit('conversation:created', payload),
    )
    this.socket.on('conversation:updated', (payload) =>
      this.events.emit('conversation:updated', payload),
    )
    this.socket.on('conversation:removed', (payload) =>
      this.events.emit('conversation:removed', payload),
    )
    this.socket.on('typing', (payload) => this.events.emit('typing', payload))
    this.socket.on('presence:update', (payload) => this.events.emit('presence:update', payload))
    this.socket.on('rate_limited', (payload) => this.events.emit('rate_limited', payload))
  }

  private async refreshExpiredToken(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.socket.io.reconnection(false)
    const refresh = this.refreshAccessToken()
      .then((token) => {
        this.setSocketToken(token)
        this.socket.io.reconnection(true)
        if (!this.closed) {
          this.socket.connect()
        }
      })
      .finally(() => {
        if (this.refreshPromise === refresh) {
          this.refreshPromise = null
        }
      })
    this.refreshPromise = refresh
    return refresh
  }

  private setSocketToken(token: string): void {
    if (token.trim().length === 0) {
      throw new Error('Access token cannot be empty')
    }
    this.socket.auth = { token }
  }

  private async runSyncAll(): Promise<MessageDto[]> {
    const conversations: ConversationDto[] = []
    let cursor: string | null = null
    const seenCursors = new Set<string>()
    do {
      const query = new URLSearchParams({ limit: '50' })
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error('Conversation synchronization returned a repeated cursor')
        }
        seenCursors.add(cursor)
        query.set('cursor', cursor)
      }
      const page = ConversationListResponse.parse(
        await this.getJson(`/conversations?${query.toString()}`),
      )
      conversations.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)

    const synchronized: MessageDto[] = []
    for (const conversation of conversations) {
      const lastSeq = await this.getLastSeq(conversation.id)
      if (lastSeq < conversation.lastSeq) {
        synchronized.push(...(await this.syncConversation(conversation.id, conversation.lastSeq)))
      }
    }
    return synchronized
  }

  private syncConversation(conversationId: string, targetSeq: number): Promise<MessageDto[]> {
    const current = this.conversationSyncs.get(conversationId)
    if (current) {
      current.targetSeq = Math.max(current.targetSeq, targetSeq)
      return current.promise
    }

    const sync: ConversationSync = { targetSeq, promise: Promise.resolve([]) }
    sync.promise = this.runSyncConversation(conversationId, sync).finally(() => {
      if (this.conversationSyncs.get(conversationId) === sync) {
        this.conversationSyncs.delete(conversationId)
      }
    })
    this.conversationSyncs.set(conversationId, sync)
    return sync.promise
  }

  private async runSyncConversation(
    conversationId: string,
    sync: ConversationSync,
  ): Promise<MessageDto[]> {
    const synchronized: MessageDto[] = []
    let highestFetchedSeq: number | undefined
    while (true) {
      const targetAtRequest = sync.targetSeq
      const lastSeq = await this.getLastSeq(conversationId)
      if (lastSeq >= targetAtRequest) {
        return mergeMessages([], synchronized)
      }

      const query = new URLSearchParams({
        afterSeq: String(lastSeq),
        limit: '100',
      })
      const page = MessageHistoryResponse.parse(
        await this.getJson(
          `/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
        ),
      )
      if (page.items.length === 0 && page.hasMore) {
        throw new Error('Message synchronization returned an empty page with more results')
      }

      synchronized.push(...page.items)
      const pageLastSeq = page.items.at(-1)?.seq
      if (pageLastSeq !== undefined) {
        if (pageLastSeq <= lastSeq) {
          throw new Error('Message synchronization did not advance the sequence')
        }
        highestFetchedSeq = pageLastSeq
        await this.setLastSeqAtLeast(conversationId, pageLastSeq)
      }

      if (page.hasMore || sync.targetSeq > targetAtRequest) {
        continue
      }

      await this.setLastSeqAtLeast(conversationId, targetAtRequest)
      if (this.ready && highestFetchedSeq !== undefined) {
        await this.markDelivered(conversationId, highestFetchedSeq)
      }
      return mergeMessages([], synchronized)
    }
  }

  private queueIncomingMessage(message: MessageDto): void {
    const previous = this.incomingQueues.get(message.conversationId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.processIncomingMessage(message))
    this.incomingQueues.set(message.conversationId, current)
    void current
      .catch((error: unknown) => this.reportError(error))
      .finally(() => {
        if (this.incomingQueues.get(message.conversationId) === current) {
          this.incomingQueues.delete(message.conversationId)
        }
      })
  }

  private async processIncomingMessage(message: MessageDto): Promise<void> {
    const lastSeq = await this.getLastSeq(message.conversationId)
    if (detectGap(lastSeq, message.seq)) {
      const missingMessages = await this.syncConversation(message.conversationId, message.seq)
      const gapMessages = missingMessages.filter((item) => item.id !== message.id)
      if (gapMessages.length > 0) {
        this.events.emit('messages:sync', {
          conversationId: message.conversationId,
          messages: gapMessages,
        })
      }
    }

    await this.setLastSeqAtLeast(message.conversationId, message.seq)
    if (this.ready && message.seq > lastSeq) {
      await this.markDelivered(message.conversationId, message.seq)
    }
    this.events.emit('message:new', { message })
  }

  private async flushOutbox(): Promise<void> {
    if (!this.ready) {
      return
    }
    if (this.flushPromise) {
      return this.flushPromise
    }

    const flush = this.runOutboxFlush()
    this.flushPromise = flush
    void flush.then(
      () => {
        if (this.flushPromise === flush) {
          this.flushPromise = null
        }
      },
      () => {
        if (this.flushPromise === flush) {
          this.flushPromise = null
        }
      },
    )
    return flush
  }

  private async runOutboxFlush(): Promise<void> {
    await this.ensureOutboxLoaded()
    for (const message of [...this.outbox]) {
      if (!this.ready) {
        return
      }
      if (message.status === 'pending') {
        await this.sendPending(message.clientMessageId)
      }
    }
  }

  private sendPending(clientMessageId: string): Promise<OutboxMessage> {
    const current = this.inFlightSends.get(clientMessageId)
    if (current) {
      return current
    }

    const sending = this.runSendAttempts(clientMessageId).finally(() => {
      if (this.inFlightSends.get(clientMessageId) === sending) {
        this.inFlightSends.delete(clientMessageId)
      }
    })
    this.inFlightSends.set(clientMessageId, sending)
    return sending
  }

  private async runSendAttempts(clientMessageId: string): Promise<OutboxMessage> {
    await this.ensureOutboxLoaded()
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
      const message = this.outbox.find((item) => item.clientMessageId === clientMessageId)
      if (!message) {
        throw new Error(`Outbox message ${clientMessageId} was not found`)
      }
      if (message.status === 'sent' || message.status === 'failed') {
        return { ...message }
      }
      if (!this.ready) {
        return { ...message }
      }

      const input = SendMessageInput.parse({
        conversationId: message.conversationId,
        clientMessageId: message.clientMessageId,
        content: message.content,
        ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      })
      try {
        const ack = await this.requestMessageAck(input)
        if (!ack.ok) {
          return this.updateOutbox(clientMessageId, {
            status: 'failed',
            error: ack.error.message,
          })
        }
        await this.updateOutbox(clientMessageId, {
          status: 'sent',
          message: ack.data.message,
          error: undefined,
        })
        await this.setLastSeqAtLeast(message.conversationId, ack.data.message.seq)
        const sentMessage = this.outbox.find((item) => item.clientMessageId === clientMessageId)
        if (!sentMessage) {
          throw new Error(`Outbox message ${clientMessageId} was not found after sending`)
        }
        return { ...sentMessage }
      } catch (error) {
        if (!this.ready) {
          return { ...message }
        }
        if (attempt === RETRY_LIMIT - 1) {
          return this.updateOutbox(clientMessageId, {
            status: 'failed',
            error: this.errorMessage(error),
          })
        }
        await this.wait(RETRY_BASE_DELAY_MS * 2 ** attempt)
      }
    }

    throw new Error(`Outbox retry loop ended unexpectedly for ${clientMessageId}`)
  }

  protected requestMessageAck(
    input: Parameters<ClientToServerEvents['message:send']>[0],
  ): Promise<SocketAck<SendMessageAck>> {
    return this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('message:send', input)
  }

  private async updateOutbox(
    clientMessageId: string,
    patch: Partial<OutboxMessage>,
  ): Promise<OutboxMessage> {
    const index = this.outbox.findIndex((message) => message.clientMessageId === clientMessageId)
    const current = this.outbox[index]
    if (!current) {
      throw new Error(`Outbox message ${clientMessageId} was not found`)
    }

    const updated = { ...current, ...patch }
    this.outbox[index] = updated
    await this.persistOutbox()
    this.events.emit('outbox:update', { ...updated })
    return { ...updated }
  }

  private async ensureOutboxLoaded(): Promise<void> {
    if (!this.outboxLoaded) {
      const loading = Promise.resolve(this.storage.getOutbox()).then((messages) => {
        this.outbox = messages.map((message) => ({ ...message }))
      })
      this.outboxLoaded = loading
      void loading.catch(() => {
        if (this.outboxLoaded === loading) {
          this.outboxLoaded = null
        }
      })
    }
    return this.outboxLoaded
  }

  private persistOutbox(): Promise<void> {
    const snapshot = this.outbox.map((message) => ({ ...message }))
    const write = this.outboxWrite
      .catch(() => undefined)
      .then(() => this.storage.setOutbox(snapshot))
    this.outboxWrite = write
    return write
  }

  private async getLastSeq(conversationId: string): Promise<number> {
    await this.sequenceWrites.get(conversationId)
    const lastSeq = await this.storage.getLastSeq(conversationId)
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      throw new Error(`Stored sequence for ${conversationId} is invalid`)
    }
    return lastSeq
  }

  private setLastSeqAtLeast(conversationId: string, seq: number): Promise<void> {
    const previous = this.sequenceWrites.get(conversationId) ?? Promise.resolve()
    const update = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.storage.getLastSeq(conversationId)
        if (seq > current) {
          await this.storage.setLastSeq(conversationId, seq)
        }
      })
    this.sequenceWrites.set(conversationId, update)
    void update.then(
      () => {
        if (this.sequenceWrites.get(conversationId) === update) {
          this.sequenceWrites.delete(conversationId)
        }
      },
      () => {
        if (this.sequenceWrites.get(conversationId) === update) {
          this.sequenceWrites.delete(conversationId)
        }
      },
    )
    return update
  }

  private async getJson(path: string): Promise<unknown> {
    const token = await this.getAccessToken()
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      throw new Error(`Request ${path} failed with status ${response.status}`)
    }
    return response.json()
  }

  private assertAck<T>(ack: SocketAck<T>): asserts ack is { ok: true; data: T } {
    if (!ack.ok) {
      throw new Error(ack.error.message)
    }
  }

  private wait(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs))
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private reportError(error: unknown): void {
    this.events.emit('client:error', new Error(this.errorMessage(error)))
  }
}
