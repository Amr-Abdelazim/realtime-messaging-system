import { createInterface } from 'node:readline'

import { ChatClient } from '../packages/client-core/src/index.js'

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

let accessToken = getAccessToken(await loginResponse.json())
let refreshCookie = getRefreshCookie(loginResponse)

const client = new ChatClient({
  baseUrl: apiBaseUrl,
  getAccessToken: () => accessToken,
  refreshAccessToken: async () => {
    const response = await fetch(`${apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { cookie: refreshCookie },
    })
    if (!response.ok) {
      throw new Error(`REST token refresh failed with status ${response.status}`)
    }

    accessToken = getAccessToken(await response.json())
    refreshCookie = getRefreshCookie(response)
    return accessToken
  },
})

client.onAny((event, ...args) => {
  console.log(event, ...args)
})
client.on('connect', () => {
  console.log('Connected')
})
client.on('connect_error', (error) => {
  console.error(`Connection failed: ${error.message}`)
})
client.on('client:error', (error) => {
  console.error(`Client error: ${error.message}`)
})
client.on('sync:complete', ({ messages }) => {
  console.log(`Synchronization complete: ${messages.length} message(s)`)
})

const input = createInterface({ input: process.stdin, output: process.stdout })
const commands =
  'Commands: send <conversationId> <text>, retry <clientMessageId>, delivered <conversationId> <upToSeq>, read <conversationId> <upToSeq>, typing on|off <conversationId>, help, reconnect, quit'
console.log(commands)
void client.connect().catch((error: unknown) => {
  console.error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`)
})

input.on('line', (line) => {
  const command = line.trim()
  if (command.toLowerCase() === 'help') {
    console.log(commands)
    return
  }
  if (command.toLowerCase() === 'reconnect') {
    void client.reconnect().catch((error: unknown) => {
      console.error(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`)
    })
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
      void client
        .send(conversationId, content)
        .then((message) => console.log('outbox', message))
        .catch((error: unknown) => {
          console.error(`Send failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      return
    }
  }

  const retryCommand = /^retry\s+(\S+)$/i.exec(command)
  if (retryCommand?.[1]) {
    void client
      .retry(retryCommand[1])
      .then((message) => console.log('outbox', message))
      .catch((error: unknown) => {
        console.error(`Retry failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return
  }

  const statusCommand = /^(delivered|read)\s+(\S+)\s+(\d+)$/i.exec(command)
  if (statusCommand) {
    const [, action, conversationId, sequence] = statusCommand
    const upToSeq = Number(sequence)
    if (action && conversationId && Number.isSafeInteger(upToSeq)) {
      const request =
        action.toLowerCase() === 'delivered'
          ? client.markDelivered(conversationId, upToSeq)
          : client.markRead(conversationId, upToSeq)
      void request
        .then((ack) => console.log('ack', ack))
        .catch((error: unknown) => {
          console.error(
            `Status update failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      return
    }
  }

  const typingCommand = /^typing\s+(on|off)\s+(\S+)$/i.exec(command)
  if (typingCommand) {
    const [, action, conversationId] = typingCommand
    if (action && conversationId) {
      client.setTyping(conversationId, action.toLowerCase() === 'on')
      return
    }
  }

  console.log(`Unknown command: ${command || '(empty)'}`)
})

input.on('close', () => client.close())

function getAccessToken(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('accessToken' in value) ||
    typeof value.accessToken !== 'string'
  ) {
    throw new Error('REST response did not contain an access token')
  }
  return value.accessToken
}

function getRefreshCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) {
    throw new Error('REST response did not contain a refresh cookie')
  }
  return cookie
}
