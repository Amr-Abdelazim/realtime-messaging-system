# Development

Start the API and worker with `pnpm dev`. The API serves HTTP and Socket.IO from the same port.

To connect the socket CLI, set `API_URL` to the REST API base URL (default `http://localhost:3000/api/v1`) and provide credentials through `EMAIL` and `PASSWORD`:

```sh
API_URL=http://localhost:3000/api/v1 EMAIL=ada@example.com PASSWORD='your-password' pnpm exec tsx scripts/socket-cli.ts
```

The CLI logs every server event and accepts `send <conversationId> <text>`, `help`, `reconnect`, and `quit`.
