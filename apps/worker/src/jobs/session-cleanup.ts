import type { PrismaClient } from '@prisma/client'

const BATCH_SIZE = 500
const REVOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

type SessionCleanupDependencies = {
  prisma: PrismaClient
}

export async function run({ prisma }: SessionCleanupDependencies): Promise<number> {
  const now = new Date()
  const revokedBefore = new Date(now.getTime() - REVOCATION_RETENTION_MS)
  const staleSessionFilter = {
    OR: [{ expiresAt: { lte: now } }, { revokedAt: { lt: revokedBefore } }],
  }
  let deletedCount = 0

  while (true) {
    const sessions = await prisma.session.findMany({
      where: staleSessionFilter,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    })
    if (sessions.length === 0) {
      return deletedCount
    }

    const result = await prisma.session.deleteMany({
      where: {
        id: { in: sessions.map(({ id }) => id) },
        ...staleSessionFilter,
      },
    })
    deletedCount += result.count
  }
}
