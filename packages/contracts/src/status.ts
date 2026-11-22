import { z } from 'zod'

export const ConversationReceipts = z.object({
  deliveredUpTo: z.number().int().nonnegative(),
  readUpTo: z.number().int().nonnegative(),
})

export type ConversationReceipts = z.infer<typeof ConversationReceipts>

export type MessageStatus = 'sent' | 'delivered' | 'read'

export function deriveStatus(seq: number, receipts: ConversationReceipts): MessageStatus {
  if (receipts.readUpTo >= seq) {
    return 'read'
  }
  if (receipts.deliveredUpTo >= seq) {
    return 'delivered'
  }
  return 'sent'
}
