import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import { io } from 'socket.io-client'

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
})
socket.onAny((event, ...args) => {
  console.log(event, ...args)
})
socket.on('connect', () => {
  console.log(`Connected: ${socket.id}`)
})
socket.on('connect_error', (error) => {
  console.error(`Connection failed: ${error.message}`)
})

const input = createInterface({ input: process.stdin, output: process.stdout })
console.log('Commands: send <conversationId> <text>, help, reconnect, quit')
input.on('line', (line) => {
  const command = line.trim()
  if (command.toLowerCase() === 'help') {
    console.log('Commands: send <conversationId> <text>, help, reconnect, quit')
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

  console.log(`Unknown command: ${command || '(empty)'}`)
})
input.on('close', () => {
  socket.disconnect()
})
