import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import { io, type Socket } from 'socket.io-client'
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '../packages/contracts/src/socket.js'

type SocketClient = Socket<ServerToClientEvents, ClientToServerEvents>

const apiBaseUrl = (process.env.API_URL ?? 'http://localhost:3000/api/v1').replace(/\/+$/, '')
const email = process.env.EMAIL
const password = process.env.PASSWORD

if (!email || !password) {
  throw new Error('Set EMAIL and PASSWORD before starting the socket CLI')
}

const loginResponse = await fetch(`${apiBaseUrl}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
if (!loginResponse.ok) {
  throw new Error(`REST login failed with status ${loginResponse.status}`)
}

const loginBody: unknown = await loginResponse.json()
if (
  typeof loginBody !== 'object' ||
  loginBody === null ||
  !('accessToken' in loginBody) ||
  typeof loginBody.accessToken !== 'string'
) {
  throw new Error('REST login response did not contain an access token')
}

const socket = io(new URL(apiBaseUrl).origin, {
  auth: { token: loginBody.accessToken },
}) as SocketClient
socket.onAny((event, ...args) => {
  console.log(event, ...args)
})
socket.on('connect', () => {
  console.log(`Connected: ${socket.id}`)
})
socket.on('connect_error', (error) => {
  console.error(`Connection failed: ${error.message}`)
})
const presenceHeartbeat = setInterval(() => {
  if (socket.connected) {
    socket.emit('presence:ping')
  }
}, 25_000)

const input = createInterface({ input: process.stdin, output: process.stdout })
const commands =
  'Commands: send <conversationId> <text>, delivered <conversationId> <upToSeq>, read <conversationId> <upToSeq>, typing on|off <conversationId>, help, reconnect, quit'
console.log(commands)
input.on('line', (line) => {
  const command = line.trim()
  if (command.toLowerCase() === 'help') {
    console.log(commands)
    return
  }
  if (command.toLowerCase() === 'reconnect') {
    socket.connect()
    return
  }
  if (command.toLowerCase() === 'quit') {
    input.close()
    return
  }

  const sendCommand = /^send\s+(\S+)\s+([\s\S]+)$/i.exec(command)
  if (sendCommand) {
    const [, conversationId, content] = sendCommand
    if (conversationId && content) {
      socket.emit(
        'message:send',
        { conversationId, clientMessageId: randomUUID(), content },
        (ack) => console.log('ack', ack),
      )
      return
    }
  }

  const statusCommand = /^(delivered|read)\s+(\S+)\s+(\d+)$/i.exec(command)
  if (statusCommand) {
    const [, action, conversationId, sequence] = statusCommand
    const upToSeq = Number(sequence)
    if (action && conversationId && Number.isSafeInteger(upToSeq)) {
      if (action.toLowerCase() === 'delivered') {
        socket.emit('message:delivered', { conversationId, upToSeq }, (ack) =>
          console.log('ack', ack),
        )
      } else {
        socket.emit('conversation:read', { conversationId, upToSeq }, (ack) =>
          console.log('ack', ack),
        )
      }
      return
    }
  }

  const typingCommand = /^typing\s+(on|off)\s+(\S+)$/i.exec(command)
  if (typingCommand) {
    const [, action, conversationId] = typingCommand
    if (action && conversationId) {
      socket.emit(action.toLowerCase() === 'on' ? 'typing:start' : 'typing:stop', {
        conversationId,
      })
      return
    }
  }

  console.log(`Unknown command: ${command || '(empty)'}`)
})
input.on('close', () => {
  clearInterval(presenceHeartbeat)
  socket.disconnect()
})
