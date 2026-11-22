import { z } from 'zod'

const HttpsAvatarUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => /^https:\/\//i.test(value), {
    message: 'Avatar URL must use HTTPS',
  })

export const UpdateProfileBody = z
  .object({
    displayName: z.string().trim().min(1).max(50).optional(),
    avatarUrl: HttpsAvatarUrl.nullable().optional(),
  })
  .refine((body) => body.displayName !== undefined || body.avatarUrl !== undefined, {
    message: 'At least one profile field must be provided',
  })

export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>

export const UserSearchQuery = z.object({
  q: z.string().trim().min(2),
  limit: z.coerce.number().int().min(1).max(20).default(10),
})

export type UserSearchQuery = z.infer<typeof UserSearchQuery>
