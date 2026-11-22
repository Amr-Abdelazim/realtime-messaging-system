# Development

Start the API and worker with `pnpm dev`. The API serves HTTP and Socket.IO from the same port.

To connect the socket CLI, set `API_URL` to the REST API base URL (default `http://localhost:3000/api/v1`) and provide credentials through `EMAIL` and `PASSWORD`:

```sh
API_URL=http://localhost:3000/api/v1 EMAIL=ada@example.com PASSWORD='your-password' pnpm exec tsx scripts/socket-cli.ts
```

The CLI logs every server event and accepts `send <conversationId> <text>`,
`retry <clientMessageId>`, `delivered <conversationId> <upToSeq>`,
`read <conversationId> <upToSeq>`, `typing on|off <conversationId>`, `help`,
`reconnect`, and `quit`.

The framework-free `@realtime-messaging/client-core` package exports
`ChatClient`, `detectGap`, and `mergeMessages`. `ChatClient` takes the API base
URL, access-token and refresh callbacks, and an optional `ChatStorage`
implementation (memory storage is the default). It handles socket reconnects,
message outbox retries, sequence synchronization, delivery acknowledgements,
and presence heartbeats.

Clients can also mark a conversation as read over REST with
`POST /conversations/:id/read` and a JSON body such as `{"upToSeq": 12}`. The
endpoint returns `204 No Content`; both REST and Socket.IO update the same read
watermarks and unread count.

Senders can delete their own messages with the Socket.IO `message:delete`
event or `DELETE /messages/:id`. Deletion is idempotent; system messages cannot
be deleted.

Authenticated clients can query `GET /presence?ids=userId1,userId2` for up to
50 users. Socket clients should emit `presence:ping` every 25 seconds; socket
presence expires after 60 seconds without a heartbeat.
