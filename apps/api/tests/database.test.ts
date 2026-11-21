import { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { disconnectDb, resetDb } from './helpers/db.js'

const prisma = new PrismaClient()

describe.skipIf(process.env.CI !== 'true')('database constraints', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await disconnectDb()
    await prisma.$disconnect()
  })

  it('enforces unique direct chat keys', async () => {
    const alice = await prisma.user.create({
      data: {
        username: 'alice_constraint',
        email: 'alice_constraint@example.com',
        displayName: 'Alice',
        passwordHash: 'hash',
      },
    })
    const bob = await prisma.user.create({
      data: {
        username: 'bob_constraint',
        email: 'bob_constraint@example.com',
        displayName: 'Bob',
        passwordHash: 'hash',
      },
    })
    const directKey = [alice.id, bob.id].sort().join(':')

    await prisma.conversation.create({
      data: {
        type: 'DIRECT',
        directKey,
        createdById: alice.id,
        participants: {
          create: [
            { userId: alice.id, role: 'OWNER' },
            { userId: bob.id, role: 'MEMBER' },
          ],
        },
      },
    })

    await expect(
      prisma.conversation.create({
        data: {
          type: 'DIRECT',
          directKey,
          createdById: bob.id,
        },
      }),
    ).rejects.toBeDefined()
  })

  it('enforces unique conversation sequence numbers', async () => {
    const user = await prisma.user.create({
      data: {
        username: 'seq_constraint',
        email: 'seq_constraint@example.com',
        displayName: 'Seq',
        passwordHash: 'hash',
      },
    })
    const conversation = await prisma.conversation.create({
      data: {
        type: 'GROUP',
        name: 'Sequence test',
        createdById: user.id,
        participants: {
          create: { userId: user.id, role: 'OWNER' },
        },
      },
    })

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        seq: 1,
        senderId: user.id,
        content: 'First',
        clientMessageId: '00000000-0000-4000-8000-000000000001',
      },
    })

    await expect(
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          seq: 1,
          senderId: user.id,
          content: 'Duplicate',
          clientMessageId: '00000000-0000-4000-8000-000000000002',
        },
      }),
    ).rejects.toBeDefined()
  })
})
