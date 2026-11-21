import { z } from 'zod'

import { IdSchema, IsoDateSchema } from './common.js'

export const RegisterBody = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase()),
  username: z
    .string()
    .trim()
    .transform((username) => username.toLowerCase())
    .pipe(
      z
        .string()
        .min(3)
        .max(20)
        .regex(/^[a-z0-9_]+$/),
    ),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(50),
})

export type RegisterBody = z.infer<typeof RegisterBody>

export const UserDto = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: IsoDateSchema,
})

export type UserDto = z.infer<typeof UserDto>

export const MeDto = UserDto.extend({
  email: z.string().email(),
})

export type MeDto = z.infer<typeof MeDto>

export const AuthResponse = z.object({
  user: MeDto,
  accessToken: z.string(),
})

export type AuthResponse = z.infer<typeof AuthResponse>
