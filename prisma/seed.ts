import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const passwordHash = await argon2.hash('Password123!')
  const users = await Promise.all(
    (
      [
        ['alice', 'alice@example.com', 'Alice'],
        ['bob', 'bob@example.com', 'Bob'],
        ['carol', 'carol@example.com', 'Carol'],
        ['dave', 'dave@example.com', 'Dave'],
        ['erin', 'erin@example.com', 'Erin'],
      ] as const
    ).map(([username, email, displayName]) =>
      prisma.user.create({
        data: {
          username,
          email,
          displayName,
          passwordHash,
        },
      }),
    ),
  )

  const [alice, bob, carol] = users
  if (!alice || !bob || !carol) {
    throw new Error('Failed to create seed users')
  }

  const directKey = [alice.id, bob.id].sort().join(':')
  const direct = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      directKey,
      createdById: alice.id,
      participants: {
        create: [
          { userId: alice.id, role: 'OWNER', joinedAtSeq: 0 },
          { userId: bob.id, role: 'MEMBER', joinedAtSeq: 0 },
        ],
      },
    },
  })

  for (let seq = 1; seq <= 20; seq += 1) {
    const sender = seq % 2 === 1 ? alice : bob
    await prisma.message.create({
      data: {
        conversationId: direct.id,
        seq,
        senderId: sender.id,
        type: 'TEXT',
        content: `Direct message ${seq}`,
        clientMessageId: randomUUID(),
      },
    })
  }

  const directMessages = await prisma.message.findMany({
    where: { conversationId: direct.id },
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true, createdAt: true },
  })

  await prisma.conversation.update({
    where: { id: direct.id },
    data: {
      lastSeq: 20,
      lastMessageId: directMessages.at(-1)?.id,
      lastMessageAt: directMessages.at(-1)?.createdAt,
    },
  })

  const group = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      name: 'Demo Group',
      createdById: alice.id,
      participants: {
        create: [
          { userId: alice.id, role: 'OWNER', joinedAtSeq: 0 },
          { userId: bob.id, role: 'MEMBER', joinedAtSeq: 0 },
          { userId: carol.id, role: 'MEMBER', joinedAtSeq: 0 },
        ],
      },
    },
  })

  for (let seq = 1; seq <= 10; seq += 1) {
    const sender = [alice, bob, carol][(seq - 1) % 3]
    if (!sender) {
      throw new Error('Missing seed sender')
    }
    await prisma.message.create({
      data: {
        conversationId: group.id,
        seq,
        senderId: sender.id,
        type: 'TEXT',
        content: `Group message ${seq}`,
        clientMessageId: randomUUID(),
      },
    })
  }

  const groupMessages = await prisma.message.findMany({
    where: { conversationId: group.id },
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true, createdAt: true },
  })

  await prisma.conversation.update({
    where: { id: group.id },
    data: {
      lastSeq: 10,
      lastMessageId: groupMessages.at(-1)?.id,
      lastMessageAt: groupMessages.at(-1)?.createdAt,
    },
  })
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
