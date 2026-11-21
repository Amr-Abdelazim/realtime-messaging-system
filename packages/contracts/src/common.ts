import { z } from 'zod'

export const IdSchema = z.string().min(1)

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export const IsoDateSchema = z.string().datetime()
