import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

export type SystemMessageMetadata = Prisma.InputJsonObject & { actorId: string }

export async function allocateSeq(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<number> {
  const conversation = await tx.conversation.update({
    where: { id: conversationId },
    data: { lastSeq: { increment: 1 } },
    select: { lastSeq: true },
  })

  return conversation.lastSeq
}

export async function createSystemMessage(
  tx: Prisma.TransactionClient,
  conversationId: string,
  text: string,
  metadata: SystemMessageMetadata,
) {
  const seq = await allocateSeq(tx, conversationId)
  const message = await tx.message.create({
    data: {
      conversationId,
      seq,
      type: 'SYSTEM',
      content: text,
      clientMessageId: randomUUID(),
      metadata,
    },
  })

  await tx.conversation.update({
    where: { id: conversationId },
    data: { lastMessageId: message.id, lastMessageAt: message.createdAt },
  })
  await tx.participant.updateMany({
    where: { conversationId, userId: { not: metadata.actorId }, leftAt: null },
    data: { unreadCount: { increment: 1 } },
  })
  await tx.participant.updateMany({
    where: { conversationId, userId: metadata.actorId, leftAt: null },
    data: {
      lastDeliveredSeq: seq,
      lastReadSeq: seq,
      unreadCount: 0,
    },
  })

  return message
}
