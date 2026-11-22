import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  AuthResponse,
  AddConversationMembersBody,
  ConversationDto,
  ConversationListQuery,
  ConversationListResponse,
  CreateConversationBody,
  ErrorCode,
  ErrorEnvelope,
  IdSchema,
  IsoDateSchema,
  LoginBody,
  PaginationQuery,
  RegisterBody,
  UpdateConversationBody,
  UpdateProfileBody,
  UserSearchQuery,
} from '../src/index.js'

describe('shared contracts', () => {
  it('validates ids and ISO timestamps', () => {
    expect(IdSchema.safeParse('user-123').success).toBe(true)
    expect(IdSchema.safeParse('').success).toBe(false)
    expect(IsoDateSchema.safeParse('2026-11-21T23:48:30.884Z').success).toBe(true)
  })

  it('coerces and bounds pagination limits', () => {
    expect(PaginationQuery.parse({ limit: '20' })).toEqual({ limit: 20 })
    expect(PaginationQuery.parse({})).toEqual({ limit: 30 })
    expect(PaginationQuery.safeParse({ limit: 101 }).success).toBe(false)
  })

  it('defines the error envelope', () => {
    const envelope = {
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid request',
        details: [{ path: 'email', message: 'Invalid email' }],
      },
    }

    expect(ErrorEnvelope.parse(envelope)).toEqual(envelope)
    expect(
      ErrorEnvelope.safeParse({
        error: {
          code: ErrorCode.INTERNAL,
          message: 'Internal server error',
          details: null,
        },
      }).success,
    ).toBe(true)

    expect(
      ErrorEnvelope.safeParse({
        error: {
          code: ErrorCode.CONFLICT,
          message: 'Email already in use',
          details: { field: 'email' },
        },
      }).success,
    ).toBe(true)
  })

  it('normalizes and validates registration contracts', () => {
    const registration = RegisterBody.parse({
      email: 'ALICE@EXAMPLE.COM',
      username: 'Alice_1',
      password: 'Password123!',
      displayName: ' Alice ',
    })

    expect(registration).toEqual({
      email: 'alice@example.com',
      username: 'alice_1',
      password: 'Password123!',
      displayName: 'Alice',
    })

    expect(
      AuthResponse.safeParse({
        user: {
          id: 'user-1',
          username: 'alice_1',
          displayName: 'Alice',
          avatarUrl: null,
          createdAt: '2026-11-21T23:48:30.884Z',
          email: 'alice@example.com',
        },
        accessToken: 'signed-jwt',
      }).success,
    ).toBe(true)
  })

  it('normalizes login email without changing the password', () => {
    expect(
      LoginBody.parse({
        email: ' ALICE@EXAMPLE.COM ',
        password: ' Password123! ',
      }),
    ).toEqual({
      email: 'alice@example.com',
      password: ' Password123! ',
    })
  })

  it('validates profile updates and user search queries', () => {
    expect(
      UpdateProfileBody.parse({
        displayName: '  Ada  ',
        avatarUrl: ' https://example.com/avatar.png ',
      }),
    ).toEqual({
      displayName: 'Ada',
      avatarUrl: 'https://example.com/avatar.png',
    })
    expect(UpdateProfileBody.parse({ avatarUrl: null })).toEqual({ avatarUrl: null })
    expect(UpdateProfileBody.safeParse({}).success).toBe(false)
    expect(
      UpdateProfileBody.safeParse({ avatarUrl: 'http://example.com/avatar.png' }).success,
    ).toBe(false)
    expect(
      UpdateProfileBody.safeParse({ avatarUrl: `https://${'a'.repeat(500)}.com` }).success,
    ).toBe(false)

    expect(UserSearchQuery.parse({ q: '  Ada  ' })).toEqual({ q: 'Ada', limit: 10 })
    expect(UserSearchQuery.parse({ q: 'Ada', limit: '20' })).toEqual({ q: 'Ada', limit: 20 })
    expect(UserSearchQuery.safeParse({ q: 'A' }).success).toBe(false)
    expect(UserSearchQuery.safeParse({ q: 'Ada', limit: 21 }).success).toBe(false)
  })

  it('validates direct conversation requests and DTOs', () => {
    expect(CreateConversationBody.parse({ type: 'DIRECT', userId: 'user-123' })).toEqual({
      type: 'DIRECT',
      userId: 'user-123',
    })
    expect(CreateConversationBody.safeParse({ type: 'DIRECT' }).success).toBe(false)
    expect(
      CreateConversationBody.parse({
        type: 'GROUP',
        name: '  Group  ',
        memberIds: ['user-123', 'user-456'],
      }),
    ).toEqual({
      type: 'GROUP',
      name: 'Group',
      memberIds: ['user-123', 'user-456'],
    })
    expect(
      CreateConversationBody.safeParse({ type: 'GROUP', name: ' ', memberIds: [] }).success,
    ).toBe(false)
    expect(UpdateConversationBody.parse({ name: '  New name  ' })).toEqual({ name: 'New name' })
    expect(AddConversationMembersBody.parse({ userIds: ['user-123'] })).toEqual({
      userIds: ['user-123'],
    })

    expect(
      ConversationDto.parse({
        id: 'conversation-1',
        type: 'DIRECT',
        name: null,
        members: [
          {
            userId: 'user-123',
            role: 'MEMBER',
            displayName: 'Ada',
            avatarUrl: null,
          },
        ],
        lastSeq: 0,
        memberCount: 1,
        lastMessage: null,
        unreadCount: 0,
        myLastReadSeq: 0,
        peerPresence: null,
      }).type,
    ).toBe('DIRECT')

    expect(ConversationListQuery.parse({})).toEqual({ limit: 30 })
    expect(ConversationListQuery.parse({ limit: '50' })).toEqual({ limit: 50 })
    expect(ConversationListQuery.safeParse({ limit: 51 }).success).toBe(false)
    expect(ConversationListResponse.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('can be composed with package schemas', () => {
    const schema = z.object({ id: IdSchema })
    expect(schema.parse({ id: '123' })).toEqual({ id: '123' })
  })
})
