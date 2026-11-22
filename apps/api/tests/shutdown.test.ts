import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import type {
  ClientToServerEvents,
  SendMessageAck,
  SendMessageInput,
  ServerToClientEvents,
  SocketAck,
} from '@realtime-messaging/contracts'
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client'
import { afterAll, describe, expect, it } from 'vitest'

import { signAccessToken } from '../src/modules/auth/tokens.js'

type TestSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>
type ChildExit = { code: number | null; signal: NodeJS.Signals | null }

const databaseUrl = new URL(
  process.env.DATABASE_URL_TEST ?? 'postgresql://messaging:messaging_dev@localhost:5432/chat_test',
)
databaseUrl.pathname = '/chat_t23_test'
const testDatabaseUrl = databaseUrl.toString()

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379')
redisUrl.pathname = '/14'

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
const redis = new Redis(redisUrl.toString())

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate a port for the shutdown test')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function waitForHttpStatus(
  url: string,
  expectedStatus: number,
  child: ChildProcess,
  output: string[],
): Promise<Response> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `API process exited before ${url} returned ${expectedStatus}: ${output.join('')}`,
      )
    }

    try {
      const response = await fetch(url)
      if (response.status === expectedStatus) {
        return response
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for ${url} to return ${expectedStatus}: ${output.join('')}`)
}

function waitForSocketReady(socket: TestSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('ready', () => resolve())
    socket.once('connect_error', reject)
    socket.connect()
  })
}

function sendMessage(
  socket: TestSocket,
  input: SendMessageInput,
): Promise<SocketAck<SendMessageAck>> {
  return new Promise((resolve) => {
    socket.emit('message:send', input, resolve)
  })
}

function sendInvalidMessage(
  socket: TestSocket,
  input: unknown,
): Promise<SocketAck<SendMessageAck>> {
  return new Promise((resolve) => {
    socket.emit('message:send', input as never, resolve)
  })
}

function metricValue(metricsText: string, name: string): number {
  const match = metricsText.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.]+)$`, 'm'))
  if (!match?.[1]) {
    throw new Error(`Metric ${name} was missing from scrape output`)
  }
  return Number(match[1])
}

describe.skipIf(process.env.CI !== 'true')('API graceful shutdown and metrics', () => {
  afterAll(async () => {
    await Promise.all([prisma.$disconnect(), redis.quit()])
  })

  it('withdraws readiness, records metrics, disconnects sockets, and exits cleanly on SIGTERM', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const user = await prisma.user.create({
      data: {
        username: `t23_${suffix}`,
        email: `t23_${suffix}@example.com`,
        passwordHash: 'shutdown-test-hash',
        displayName: 'T23 Shutdown Test',
      },
      select: { id: true },
    })
    const conversation = await prisma.conversation.create({
      data: {
        type: 'GROUP',
        name: `T23 ${suffix}`,
        createdById: user.id,
        participants: {
          create: [{ userId: user.id, role: 'OWNER' }],
        },
      },
      select: { id: true },
    })

    const port = await reservePort()
    const accessToken = await signAccessToken({ userId: user.id, sessionId: randomUUID() })
    const output: string[] = []
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        TRUST_PROXY: '0',
        INSTANCE_ID: 't23-shutdown-test',
        DATABASE_URL: testDatabaseUrl,
        DATABASE_URL_TEST: testDatabaseUrl,
        REDIS_URL: redisUrl.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (data: Buffer) => output.push(data.toString()))
    child.stderr?.on('data', (data: Buffer) => output.push(data.toString()))
    const childExit = waitForChildExit(child)
    const socket = createSocketClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      autoConnect: false,
      reconnection: false,
      timeout: 5000,
      transports: ['websocket'],
    }) as TestSocket

    try {
      await waitForHttpStatus(`http://127.0.0.1:${port}/ready`, 200, child, output)
      await waitForSocketReady(socket)

      const ack = await sendMessage(socket, {
        conversationId: conversation.id,
        clientMessageId: randomUUID(),
        content: 'Measure this message',
      })
      expect(ack.ok).toBe(true)

      const invalidAck = await sendInvalidMessage(socket, {})
      expect(invalidAck.ok).toBe(false)

      await redis.set(`rl:sock:${user.id}:message:send`, '20', 'EX', 10)
      const limitedAck = await sendMessage(socket, {
        conversationId: conversation.id,
        clientMessageId: randomUUID(),
        content: 'This request should be rate limited',
      })
      expect(limitedAck.ok).toBe(false)

      const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(metricsResponse.status).toBe(200)
      const metricsText = await metricsResponse.text()
      expect(metricValue(metricsText, 'messages_sent_total')).toBe(1)
      expect(metricValue(metricsText, 'sockets_connected')).toBe(1)
      expect(metricValue(metricsText, 'socket_ack_errors_total')).toBe(2)
      expect(metricValue(metricsText, 'rate_limited_total')).toBe(1)
      expect(metricValue(metricsText, 'message_send_duration_seconds_count')).toBe(2)
      expect(metricValue(metricsText, 'http_request_duration_seconds_count')).toBeGreaterThan(0)

      const disconnected = new Promise<void>((resolve) => {
        socket.once('disconnect', () => resolve())
      })
      expect(child.kill('SIGTERM')).toBe(true)
      await waitForHttpStatus(`http://127.0.0.1:${port}/ready`, 503, child, output)
      await disconnected
      expect(await childExit).toEqual({ code: 0, signal: null })
    } finally {
      socket.disconnect()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await childExit
      }
      await Promise.all([
        prisma.conversation.deleteMany({ where: { id: conversation.id } }),
        prisma.user.deleteMany({ where: { id: user.id } }),
      ])
      await redis.del(
        `presence:${user.id}`,
        `presence:pending-offline:${user.id}`,
        `lastSeen:${user.id}`,
        `rl:sock:${user.id}:message:send`,
      )
      await redis.srem('presence:active', user.id)
      await redis.srem('lastSeen:dirty', user.id)
    }
  }, 30_000)
})
