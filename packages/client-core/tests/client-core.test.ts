import { describe, expect, it } from 'vitest'

import type { MessageDto } from '@realtime-messaging/contracts'
import { detectGap, mergeMessages } from '../src/index.js'

function message(id: string, seq: number, content = id): MessageDto {
  return {
    id,
    conversationId: 'conversation-123',
    seq,
    senderId: 'user-123',
    type: 'TEXT',
    content,
    clientMessageId: 'c6cf1d2b-6eaa-4ca0-82e0-8ca46abfe807',
    replyTo: null,
    createdAt: '2025-01-02T03:04:05.000Z',
    deletedAt: null,
  }
}

describe('client-core synchronization helpers', () => {
  it('detects only forward gaps in the local sequence', () => {
    expect(detectGap(3, 3)).toBe(false)
    expect(detectGap(3, 4)).toBe(false)
    expect(detectGap(3, 5)).toBe(true)
    expect(detectGap(3, 2)).toBe(false)
  })

  it('merges by message id, prefers incoming data, and sorts by sequence', () => {
    expect(
      mergeMessages(
        [message('message-2', 2, 'old'), message('message-3', 3)],
        [message('message-1', 1), message('message-2', 2, 'updated')],
      ),
    ).toEqual([
      message('message-1', 1),
      message('message-2', 2, 'updated'),
      message('message-3', 3),
    ])
  })
})
