import { z } from 'zod'

import { IdSchema, IsoDateSchema } from './common.js'

export const PresenceQuery = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((id) => id.trim()))
    .pipe(z.array(IdSchema).min(1).max(50)),
})

export type PresenceQuery = z.infer<typeof PresenceQuery>

export const PresenceListResponse = z.object({
  items: z.array(
    z.object({
      userId: IdSchema,
      online: z.boolean(),
      lastSeenAt: IsoDateSchema.nullable(),
    }),
  ),
})

export type PresenceListResponse = z.infer<typeof PresenceListResponse>
