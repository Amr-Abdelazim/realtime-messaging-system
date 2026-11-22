import type { MessageDto } from '@realtime-messaging/contracts'

export function detectGap(localLastSeq: number, incomingSeq: number): boolean {
  return incomingSeq > localLastSeq + 1
}

export function mergeMessages(
  existing: readonly MessageDto[],
  incoming: readonly MessageDto[],
): MessageDto[] {
  const messagesById = new Map(existing.map((message) => [message.id, message]))
  for (const message of incoming) {
    messagesById.set(message.id, message)
  }
  return [...messagesById.values()].sort(
    (left, right) => left.seq - right.seq || left.id.localeCompare(right.id),
  )
}
