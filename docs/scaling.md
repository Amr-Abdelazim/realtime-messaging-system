# Running multiple API instances

The API uses the Socket.IO Redis adapter to fan out room broadcasts and room
membership operations between processes. Each API instance uses dedicated Redis
publisher and subscriber connections, while the existing shared Redis
connection continues to serve presence and rate limiting.

## Local Compose stack

Copy `.env.example` to `.env`, set `JWT_ACCESS_SECRET` to a random secret of at
least 32 characters, then run:

```sh
docker compose up --build
```

Compose starts Postgres and Redis, runs `prisma migrate deploy` once, starts two
API instances and the maintenance worker, and exposes nginx at
`http://localhost:8080`. For example,
`GET http://localhost:8080/health` returns the responding `instanceId`.
`GET /ready` reports Postgres and Redis readiness. The root path returns 404
until the web app is added in a later milestone.

API and Socket.IO traffic is balanced between `api1` and `api2`. Inspect
`docker compose logs -f api1 api2 worker` to see the structured logs and
`instanceId` for each process. The worker runs last-seen flush and presence
sweep every 30 seconds, session cleanup hourly, and unread reconciliation at
midnight UTC. The database and Redis are available only on the Compose network.

## Realtime message path

Clients connect directly to nginx using WebSocket transport only; polling
fallback is intentionally disabled so the load balancer does not need sticky
sessions. A client can connect to either API instance. That instance publishes
room broadcasts and room join/leave commands through Redis, and the other
instances deliver them to their local sockets. This covers messages, typing,
delivery/read status, presence updates, and adding/removing connected members
from conversation rooms.

The `INSTANCE_ID` setting defaults to the machine hostname and is included in
every API log line and in `/health`. Compose assigns `api1` and `api2`
explicitly. Set `TRUST_PROXY=1` when running behind nginx so Express uses the
forwarded client address. Replace the example database password and JWT secret
before exposing the stack; enable secure cookies when serving over HTTPS.
