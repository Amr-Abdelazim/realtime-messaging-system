import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL_TEST,
    },
  },
})

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE "Message", "Participant", "Conversation", "Session", "User"
        RESTART IDENTITY CASCADE
    `)
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect()
}
