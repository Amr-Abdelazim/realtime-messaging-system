# Realtime Messaging System: Project Document

*Node.js, WebSockets and realtime design. Version 1.0, scoped to a finishable MVP.*

## 1. Overview 

### 1.1 Goal

Build a realtime messaging system (direct and group chats) whose main purpose is to demonstrate backend engineering skills: authenticated WebSockets, reliable message delivery, horizontal scaling, presence, offline sync, workers, and clean API contracts.

It is **not** a WhatsApp clone. Features are chosen to show realtime design skill, not feature count.

### 1.2 What the finished MVP can do

- Register, log in, log out, refresh sessions securely
- Search users, start a 1-to-1 chat, create groups
- Send and receive text messages instantly, with replies and delete
- See sent / delivered / read status, typing indicators, online presence
- Reconnect after a network drop and receive every missed message, in order, with no duplicates
- Run as 2+ API instances behind a load balancer, with everything started by one `docker compose up`

### 1.3 Out of scope for the MVP

File and image attachments, reactions, message edit, push notifications, message search, voice/video calls, stories, E2E encryption, friend requests, admin dashboard. These are listed in section 21 as post-MVP.

## 2. Requirements Summary

### 2.1 Functional (MVP)

| ID | Requirement |
| --- | --- |
| F1 | Register / login with email + password; access token + refresh token; logout revokes the session |
| F2 | View and edit own profile (display name, avatar URL) |
| F3 | Search users by username or display name |
| F4 | Create or open a direct chat (no duplicates for the same pair) |
| F5 | Create a group, rename it, add and remove members, leave |
| F6 | Chat list sorted by latest activity with last message and unread count |
| F7 | Send text messages in realtime (max 4000 chars), reply to a message |
| F8 | Load history with cursor pagination |
| F9 | Delete own message (for everyone, soft delete) |
| F10 | Delivery and read status |
| F11 | Typing indicator |
| F12 | Online / offline presence and last seen |
| F13 | Automatic gap-fill after reconnect |

### 2.2 Non-functional targets

| Area | Target | How to verify |
| --- | --- | --- |
| Latency | message delivery p95 < 200 ms for connected users | k6 load test |
| History | 30 messages loaded p95 < 300 ms | k6 / query timing |
| Concurrency | 1,000+ concurrent sockets per instance | k6 WebSocket test |
| Delivery | at-least-once delivery, exactly-once effect via idempotency | integration test with forced retries |
| Ordering | strict per-conversation order | test with concurrent senders |
| Scalability | stateless API, 2+ instances, cross-instance delivery | integration test with 2 instances |
| Security | argon2 hashing, JWT on handshake, per-conversation authorization, validation, rate limits | tests + review |
| Operability | `/health`, `/ready`, structured logs, graceful shutdown | manual + test |
| Maintainability | TypeScript strict, lint, shared contracts, integration tests | CI |

## 3. Architecture

### 3.1 Component diagram

```text
                +--------------------+
                |   Web client       |
                | React + socket.io  |
                +---------+----------+
                          | HTTPS (REST) + WSS (Socket.IO)
                +---------v----------+
                |  Load balancer     |  (nginx, sticky not required)
                +----+----------+----+
                     |          |
             +-------v--+   +---v------+
             | API #1   |   | API #2   |   Express + Socket.IO
             +----+-----+   +-----+----+
                  |  \           /  |
                  |   +---------+   |
                  |   |  Redis  |   |  pub/sub adapter, presence,
                  |   +----+----+   |  rate limits, BullMQ queues
                  |        |        |
             +----v--------v--------v----+
             |        PostgreSQL         |  source of truth
             +---------------------------+
                           ^
                    +------+-------+
                    |  Worker(s)   |  BullMQ jobs
                    +--------------+
```

### 3.2 Responsibilities

| Component | Responsibility |
| --- | --- |
| **Web** | UI, local message cache, optimistic sending, reconnect logic |
| **API (REST)** | Auth, users, conversations, history, anything request/response |
| **API (Socket.IO)** | Sending messages, acks, typing, presence, status events |
| **Redis** | Socket.IO adapter (cross-instance fan-out), presence, rate limits, job queues |
| **PostgreSQL** | All durable data: users, sessions, conversations, messages |
| **Worker** | Background jobs: last-seen flush, session cleanup, unread reconciliation |
| **Load balancer** | Routes HTTP and WebSocket traffic to API instances |

### 3.3 Key design principles

1. **Database first, then broadcast.** A message is acknowledged only after it is committed to PostgreSQL. Realtime is a delivery optimization; the database is the truth.
2. **Realtime is lossy, sync is not.** Events can be missed (disconnects), so the client can always repair state through REST using sequence numbers.
3. **Per-conversation sequence numbers** (`seq`) give strict ordering and make gap detection trivial.
4. **Idempotent writes** via `clientMessageId`, so retries are safe.
5. **Stateless API servers.** All shared state lives in Redis or PostgreSQL.
6. **One shared contracts package** (Zod schemas) used by API, worker and web, so types never drift.

## 4. Tech Stack and Decisions

| Concern | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript (strict) | safety, shared types |
| HTTP | Express (or Fastify) | familiar, huge ecosystem |
| Realtime | Socket.IO | rooms, acks, reconnection, Redis adapter built in |
| ORM / DB | Prisma + PostgreSQL | typed queries, migrations |
| Cache / pub-sub | Redis | adapter, presence, rate limit, queues |
| Jobs | BullMQ | repeatable jobs, retries, Redis based |
| Validation | Zod | one schema for runtime + types |
| Auth | JWT (access) + opaque rotating refresh token | secure and simple |
| Hashing | argon2 | modern default |
| Logging | pino | structured JSON |
| Tests | Vitest + Supertest + socket.io-client | fast, same language |
| Load test | k6 (or Artillery) | WebSocket scenarios |
| Frontend | React + Vite + TypeScript, Zustand, TanStack Query | light and modern |
| Packaging | pnpm workspaces monorepo, Docker Compose | one-command setup |

### 4.1 Decision log (write these in your README)

| Decision | Alternative | Why this choice |
| --- | --- | --- |
| Socket.IO over raw `ws` | `ws` | built-in rooms, acks, Redis adapter; less plumbing to get wrong |
| Per-conversation `seq` | sort by UUIDv7 / timestamp | exact ordering, cheap gap detection, simple sync |
| Persist before broadcast | broadcast then persist (queue) | simpler and safer; ack means durable |
| Refresh token in httpOnly cookie | localStorage | protects it from XSS |
| Delivered/read as `seq` watermarks per participant | per-message receipt rows | tiny storage, O(1) updates; fine for MVP |
| `unreadCount` column | count on read | fast chat list; reconciled by worker |
| Postgres only for messages | Cassandra/Scylla | enough for the MVP; mention as the scale-out path |

## 5. Repository Structure

```text
realtime-messaging/
  apps/
    api/
      src/
        main.ts                  # bootstrap, graceful shutdown
        config/env.ts            # zod-validated env
        http/
          app.ts                 # express app
          middleware/            # auth, error, rate-limit, request-id
          routes/                # auth, users, conversations, messages, health
        realtime/
          server.ts              # socket.io setup + redis adapter
          auth.ts                # handshake JWT middleware
          handlers/              # message, typing, presence, read
          rooms.ts               # join/leave helpers
        modules/
          auth/                  # service, repo
          users/
          conversations/
          messages/
          presence/              # redis presence logic
        infra/
          prisma.ts  redis.ts  logger.ts  queue.ts
      test/
      Dockerfile
    worker/
      src/
        main.ts
        jobs/ lastSeenFlush.ts  sessionCleanup.ts  unreadReconcile.ts
      Dockerfile
    web/
      src/
        main.tsx  App.tsx
        api/                     # REST client + query hooks
        realtime/                # socket client, event bindings
        store/                   # zustand stores
        features/ auth/ chats/ chat/ groups/ presence/
        components/
      Dockerfile
  packages/
    contracts/
      src/ rest.ts  socket.ts  models.ts  errors.ts
  prisma/
    schema.prisma
    migrations/
  infra/
    nginx.conf
    k6/ send-messages.js
  docker-compose.yml
  .env.example
  README.md
```

**Layering rule for the API:** `routes/handlers -> service -> repository (Prisma)`. Socket handlers and REST routes both call the same services, so business rules (authorization, idempotency) exist once.

## 6. Database Design

### 6.1 Tables (MVP)

`User`, `Session`, `Conversation`, `Participant`, `Message`. Nothing else is needed for the MVP.

### 6.2 Prisma schema

```prisma
generator client { provider = "prisma-client-js" }

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ConversationType { DIRECT GROUP }
enum ParticipantRole  { OWNER ADMIN MEMBER }
enum MessageType      { TEXT SYSTEM }

model User {
  id           String    @id @default(uuid(7))
  username     String    @unique
  email        String    @unique
  passwordHash String
  displayName  String
  avatarUrl    String?
  lastSeenAt   DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  sessions             Session[]
  participants         Participant[]
  messages             Message[]
  createdConversations Conversation[] @relation("ConversationCreator")

  @@index([displayName])
}

model Session {
  id           String    @id @default(uuid(7))
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  familyId     String                      // rotation chain, for reuse detection
  tokenHash    String    @unique           // sha256 of the opaque refresh token
  userAgent    String?
  ip           String?
  expiresAt    DateTime
  revokedAt    DateTime?
  createdAt    DateTime  @default(now())

  @@index([userId])
  @@index([familyId])
  @@index([expiresAt])
}

model Conversation {
  id            String           @id @default(uuid(7))
  type          ConversationType
  name          String?                       // groups only
  directKey     String?          @unique      // "minUserId:maxUserId" for DIRECT
  createdById   String?
  createdBy     User?            @relation("ConversationCreator", fields: [createdById], references: [id], onDelete: SetNull)

  lastSeq       Int              @default(0)  // last assigned message seq
  lastMessageId String?          @unique
  lastMessage   Message?         @relation("LastMessage", fields: [lastMessageId], references: [id], onDelete: SetNull)
  lastMessageAt DateTime?

  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  participants  Participant[]
  messages      Message[]        @relation("ConversationMessages")

  @@index([lastMessageAt(sort: Desc)])
}

model Participant {
  conversationId   String
  conversation     Conversation    @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  userId           String
  user             User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  role             ParticipantRole @default(MEMBER)
  joinedAt         DateTime        @default(now())
  leftAt           DateTime?

  // watermarks (all are message seq numbers within this conversation)
  lastDeliveredSeq Int             @default(0)
  lastReadSeq      Int             @default(0)
  unreadCount      Int             @default(0)
  joinedAtSeq      Int             @default(0) // member can't see messages before this seq

  @@id([conversationId, userId])
  @@index([userId, leftAt])
}

model Message {
  id              String       @id @default(uuid(7))
  conversationId  String
  conversation    Conversation @relation("ConversationMessages", fields: [conversationId], references: [id], onDelete: Cascade)
  seq             Int                           // strictly increasing per conversation
  senderId        String?
  sender          User?        @relation(fields: [senderId], references: [id], onDelete: SetNull)
  type            MessageType  @default(TEXT)
  content         String       @db.VarChar(4000)
  clientMessageId String                        // client generated UUID, idempotency key
  replyToId       String?
  replyTo         Message?     @relation("Replies", fields: [replyToId], references: [id], onDelete: SetNull)
  replies         Message[]    @relation("Replies")
  createdAt       DateTime     @default(now())
  deletedAt       DateTime?

  lastMessageOf   Conversation? @relation("LastMessage")

  @@unique([conversationId, seq])
  @@unique([senderId, clientMessageId])
  @@index([conversationId, seq(sort: Desc)])
}
```

### 6.3 Rules enforced by the schema and services

| Rule | How |
| --- | --- |
| One direct chat per user pair | `directKey = sort([a,b]).join(":")`, unique |
| No duplicate messages on retry | unique `(senderId, clientMessageId)`; on conflict return the existing message |
| Strict order in a conversation | `seq` assigned inside a transaction (see 6.4); unique `(conversationId, seq)` |
| New members cannot read old history | `joinedAtSeq` set to `lastSeq` at join time; history queries use `seq > joinedAtSeq` |
| Deleted messages keep their slot | soft delete: `deletedAt` set, `content` cleared when returned |
| Chat survives account removal | `senderId` is `SetNull` |

### 6.4 The send transaction (the heart of the system)

```ts
await prisma.$transaction(async (tx) => {
  // 1. idempotency: already stored?
  const existing = await tx.message.findUnique({
    where: { senderId_clientMessageId: { senderId, clientMessageId } },
  });
  if (existing) return { message: existing, duplicate: true };

  // 2. authorization: sender is an active participant
  const me = await tx.participant.findUnique({
    where: { conversationId_userId: { conversationId, userId: senderId } },
  });
  if (!me || me.leftAt) throw new ForbiddenError();

  // 3. atomically take the next seq (row lock serializes senders per conversation)
  const conv = await tx.conversation.update({
    where: { id: conversationId },
    data: { lastSeq: { increment: 1 } },
    select: { lastSeq: true },
  });

  // 4. insert message
  const message = await tx.message.create({
    data: { conversationId, seq: conv.lastSeq, senderId, content, clientMessageId, replyToId },
  });

  // 5. update conversation pointer + unread counters for everyone else
  await tx.conversation.update({
    where: { id: conversationId },
    data: { lastMessageId: message.id, lastMessageAt: message.createdAt },
  });
  await tx.participant.updateMany({
    where: { conversationId, userId: { not: senderId }, leftAt: null },
    data: { unreadCount: { increment: 1 } },
  });
  // sender's own watermarks move forward
  await tx.participant.update({
    where: { conversationId_userId: { conversationId, userId: senderId } },
    data: { lastDeliveredSeq: conv.lastSeq, lastReadSeq: conv.lastSeq, unreadCount: 0 },
  });
  return { message, duplicate: false };
});
```

A race on the unique constraint (two retries at once) is caught and resolved by re-reading the existing row.

### 6.5 Status derivation

- **Direct chat:** message is `read` if the other participant's `lastReadSeq >= seq`, `delivered` if `lastDeliveredSeq >= seq`, otherwise `sent`.
- **Group chat:** use the minimum watermark across all other active members ("delivered/read to everyone"). Optional later: show counts.

### 6.6 Main queries and the indexes that serve them

| Query | Index |
| --- | --- |
| History page: `conversationId = ? AND seq < ? ORDER BY seq DESC LIMIT 30` | `(conversationId, seq DESC)` |
| Gap fill: `conversationId = ? AND seq > ? ORDER BY seq ASC LIMIT 100` | same index |
| Chat list: participants of user, then conversations by `lastMessageAt` | `Participant(userId, leftAt)`, `Conversation(lastMessageAt)` |
| User search | `username` unique, `displayName` index (use `ILIKE` or `pg_trgm` later) |

## 7. REST API Contract

**Base path:** `/api/v1`. **Format:** JSON. **Auth:** `Authorization: Bearer <accessToken>` except where noted. All inputs are validated by Zod schemas from `packages/contracts`.

### 7.1 Conventions

- **Timestamps:** ISO 8601 UTC strings.
- **Pagination:** cursor based, using `seq` (`beforeSeq`, `afterSeq`) and `limit` (default 30, max 100).
- **Error envelope:**

```json
{ "error": { "code": "FORBIDDEN", "message": "Not a member of this conversation", "details": null } }
```

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | body or query failed validation (`details` lists fields) |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | missing, invalid or expired token |
| 403 | `FORBIDDEN` | authenticated but not allowed |
| 404 | `NOT_FOUND` | resource missing (also used to avoid leaking existence) |
| 409 | `CONFLICT` | e.g. email or username taken |
| 429 | `RATE_LIMITED` | includes `Retry-After` header |
| 500 | `INTERNAL` | unexpected, logged with request id |

### 7.2 Auth

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ email, username, password, displayName }` | `201 { user, accessToken }` + refresh cookie |
| POST | `/auth/login` | `{ email, password }` | `200 { user, accessToken }` + refresh cookie |
| POST | `/auth/refresh` | none (cookie) | `200 { accessToken }` + rotated refresh cookie |
| POST | `/auth/logout` | none (cookie) | `204`, session revoked, cookie cleared |

Rules:

- Password: min 8 chars. Username: 3-20 chars, `[a-z0-9_]`, stored lowercase.
- Access token: JWT, 15 min, claims `sub` (user id), `sid` (session id), `iat`, `exp`.
- Refresh token: random 32 bytes, stored only as sha256 hash. Cookie: `httpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`.
- **Rotation with reuse detection:** every refresh issues a new token in the same `familyId` and revokes the old one. If an already-revoked token is presented, revoke the whole family (token theft signal).
- Rate limits: login and register 10/min per IP; login also 5 failures per account per 15 min.

### 7.3 Users

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users/me` | current user |
| PATCH | `/users/me` | `{ displayName?, avatarUrl? }` |
| GET | `/users?q=ali&limit=20` | search by username/display name, excludes self, min 2 chars |
| GET | `/users/:id` | public profile `{ id, username, displayName, avatarUrl }` |

### 7.4 Conversations

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| GET | `/conversations` | `limit`, `cursor` (by `lastMessageAt`) | list with `lastMessage`, `unreadCount`, `lastSeq`, peer `online` for direct |
| POST | `/conversations` | direct: `{ type: "DIRECT", userId }` or group: `{ type: "GROUP", name, memberIds[] }` | `201` conversation (direct returns existing one with `200` if it already exists) |
| GET | `/conversations/:id` |  | details + members + roles |
| PATCH | `/conversations/:id` | `{ name }` (group, admin+) | updated conversation |
| POST | `/conversations/:id/members` | `{ userIds[] }` (group, admin+) | updated members |
| DELETE | `/conversations/:id/members/:userId` | (group, admin+ or self) | `204` |
| POST | `/conversations/:id/leave` |  | `204` (owner must transfer ownership first, or the oldest admin becomes owner) |
| POST | `/conversations/:id/read` | `{ upToSeq }` | `204` (REST fallback of the socket event) |

Side effects: adding/removing members emits `conversation:updated` / `conversation:removed` to the affected users over sockets and inserts a `SYSTEM` message ("Ali added Sara").

### 7.5 Messages

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/conversations/:id/messages` | `beforeSeq?`, `limit?` | `{ items: Message[], hasMore }` newest first |
| GET | `/conversations/:id/messages` | `afterSeq`, `limit?` | `{ items: Message[], hasMore }` oldest first (gap fill) |
| DELETE | `/messages/:id` |  | `204` (sender only), then `message:deleted` is broadcast |

Sending messages is done over the socket (section 9); an optional REST fallback `POST /conversations/:id/messages` can reuse the same service and idempotency key.

### 7.6 Operations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness: process is up |
| GET | `/ready` | readiness: PostgreSQL and Redis reachable |

### 7.7 Core DTOs (in `packages/contracts`)

```ts
export const MessageDto = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  senderId: z.string().nullable(),
  type: z.enum(['TEXT', 'SYSTEM']),
  content: z.string().nullable(),          // null when deleted
  clientMessageId: z.string().uuid(),
  replyTo: z.object({ id: z.string(), senderId: z.string().nullable(), preview: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});

export const ConversationDto = z.object({
  id: z.string(),
  type: z.enum(['DIRECT', 'GROUP']),
  name: z.string().nullable(),
  members: z.array(z.object({
    userId: z.string(), role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
    displayName: z.string(), avatarUrl: z.string().nullable(),
  })),
  lastSeq: z.number().int(),
  lastMessage: MessageDto.nullable(),
  unreadCount: z.number().int(),
  myLastReadSeq: z.number().int(),
  peerPresence: z.object({ online: z.boolean(), lastSeenAt: z.string().datetime().nullable() }).nullable(),
});
```

## 8. Realtime Contract (Socket.IO)

### 8.1 Connection and authentication

- **URL:** same origin as the API, path `/socket.io`. Transports: `websocket` first, `polling` as fallback.
- **Handshake:** the client passes the access token: `io(url, { auth: { token: accessToken } })`.
- **Server middleware** verifies the JWT and checks that the session (`sid`) is not revoked. On failure it rejects with `connect_error` (`message: "TOKEN_EXPIRED"` or `"UNAUTHENTICATED"`).
- **Token refresh:** on `TOKEN_EXPIRED` the client calls `POST /auth/refresh`, updates `socket.auth.token`, and reconnects. For long-lived sockets the server also disconnects the socket when the access token expires (timer set at connect time); the client reconnects with a fresh token.
- **After auth succeeds**, the server:
  1. joins the socket to room `user:{userId}` (personal room, used for targeted events and for multi-device)
  2. joins the socket to `conv:{conversationId}` for every active conversation of the user
  3. registers presence (section 10)
  4. emits `ready { serverTime }`

### 8.2 Ack convention

Every client-to-server event that changes state uses a Socket.IO acknowledgement callback with this shape:

```ts
type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
```

The client sets a timeout (for example 5 s). If it expires with no ack, the message is retried with the **same** `clientMessageId`.

### 8.3 Client to server events

| Event | Payload | Ack data | Notes |
| --- | --- | --- | --- |
| `message:send` | `{ conversationId, clientMessageId, content, replyToId? }` | `{ message: MessageDto, duplicate: boolean }` | validates, authorizes, persists, broadcasts |
| `message:delete` | `{ messageId }` | `{ messageId, seq }` | sender only |
| `message:delivered` | `{ conversationId, upToSeq }` | `{}` | sent automatically by the client when it receives messages; advances `lastDeliveredSeq` |
| `conversation:read` | `{ conversationId, upToSeq }` | `{ unreadCount }` | advances `lastReadSeq`, resets/reduces `unreadCount` |
| `typing:start` | `{ conversationId }` | none | fire and forget; client throttles to once per 3 s |
| `typing:stop` | `{ conversationId }` | none |  |
| `presence:ping` | `{}` | none | heartbeat every 25 s, refreshes presence TTL |

All payloads are validated with Zod. Invalid payloads return `{ ok: false, error: { code: "VALIDATION_ERROR" } }` and are never processed.

### 8.4 Server to client events

| Event | Payload | Sent to |
| --- | --- | --- |
| `ready` | `{ serverTime }` | the connecting socket |
| `message:new` | `{ message: MessageDto }` | room `conv:{id}` (all members, including the sender's other devices) |
| `message:deleted` | `{ conversationId, messageId, seq }` | room `conv:{id}` |
| `message:status` | `{ conversationId, userId, kind: delivered or read, upToSeq }` | room `conv:{id}` |
| `conversation:created` | `{ conversation: ConversationDto }` | room `user:{id}` of each new member |
| `conversation:updated` | `{ conversation: ConversationDto }` | room `conv:{id}` (rename, members changed) |
| `conversation:removed` | `{ conversationId }` | room `user:{id}` of the removed member |
| `typing` | `{ conversationId, userId, isTyping }` | room `conv:{id}` except the sender |
| `presence:update` | `{ userId, online, lastSeenAt }` | rooms `conv:{id}` shared with that user |
| `rate_limited` | `{ event, retryAfterMs }` | the offending socket |

### 8.5 Zod contract example (`packages/contracts/src/socket.ts`)

```ts
export const SendMessageInput = z.object({
  conversationId: z.string(),
  clientMessageId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
  replyToId: z.string().optional(),
});

export interface ClientToServerEvents {
  'message:send': (p: z.infer<typeof SendMessageInput>, ack: (r: Ack<{ message: MessageDto; duplicate: boolean }>) => void) => void;
  'message:delete': (p: { messageId: string }, ack: (r: Ack<{ messageId: string; seq: number }>) => void) => void;
  'message:delivered': (p: { conversationId: string; upToSeq: number }, ack: (r: Ack<{}>) => void) => void;
  'conversation:read': (p: { conversationId: string; upToSeq: number }, ack: (r: Ack<{ unreadCount: number }>) => void) => void;
  'typing:start': (p: { conversationId: string }) => void;
  'typing:stop': (p: { conversationId: string }) => void;
  'presence:ping': () => void;
}

export interface ServerToClientEvents {
  ready: (p: { serverTime: string }) => void;
  'message:new': (p: { message: MessageDto }) => void;
  'message:deleted': (p: { conversationId: string; messageId: string; seq: number }) => void;
  'message:status': (p: { conversationId: string; userId: string; kind: 'delivered' | 'read'; upToSeq: number }) => void;
  'conversation:created': (p: { conversation: ConversationDto }) => void;
  'conversation:updated': (p: { conversation: ConversationDto }) => void;
  'conversation:removed': (p: { conversationId: string }) => void;
  typing: (p: { conversationId: string; userId: string; isTyping: boolean }) => void;
  'presence:update': (p: { userId: string; online: boolean; lastSeenAt: string | null }) => void;
  rate_limited: (p: { event: string; retryAfterMs: number }) => void;
}
```

### 8.6 Error codes for acks

`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN` (not a member), `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL`. Internal errors never leak stack traces; they are logged with the socket id and user id.

## 9. Core Flows

### 9.1 Sending a message

```text
Sender client                API instance A             Redis            API instance B        Recipient client
     | message:send (cid)          |                       |                    |                     |
     |---------------------------->| validate + rate limit |                    |                     |
     |                             | TX: idempotency, auth, seq++, insert       |                     |
     |                             | emit to room conv:X --> pub/sub ---------->| deliver to sockets  |
     |                             |                       |                    |-------------------->| message:new
     |<--- ack { message } --------|                       |                    |                     |
     |                             |                       |                    |<-- message:delivered|
     |                             |<------------------- pub/sub ---------------|  (update watermark) |
     |<------- message:status (delivered) -----------------|                    |                     |
```

Step by step:

1. Client generates `clientMessageId` (UUID), shows the message immediately as **sending** (optimistic UI), emits `message:send`.
2. Server validates the payload, applies the rate limit, runs the transaction from section 6.4.
3. Server emits `message:new` to room `conv:{id}`. The Redis adapter delivers it to sockets on every instance.
4. Server acks the sender with the stored message (real `id` and `seq`). Client replaces the optimistic entry, status becomes **sent**.
5. Each receiving client emits `message:delivered { upToSeq }`; server advances `lastDeliveredSeq` and broadcasts `message:status`. Sender's status becomes **delivered**.
6. When the recipient opens the chat (or it is visible), the client emits `conversation:read`; the server advances `lastReadSeq`, resets `unreadCount`, broadcasts `message:status` with `kind: "read"`.

### 9.2 Retry and idempotency

- No ack within the timeout, or socket disconnected: the client keeps the message in a local **outbox** (state `sending`/`failed`) and re-emits with the **same** `clientMessageId` after reconnecting.
- Server returns `{ duplicate: true, message }` for an already stored message. Nothing is inserted or broadcast twice.
- After 5 failed attempts the message is marked **failed** with a manual retry button.

### 9.3 Reconnect and gap fill

1. Socket reconnects (new handshake, rooms rejoined).
2. Client calls `GET /conversations` and compares each `lastSeq` with its locally stored `lastSeq`.
3. For every conversation with `serverLastSeq > localLastSeq`, call `GET /conversations/:id/messages?afterSeq=localLastSeq` (repeat while `hasMore`).
4. Client sends `message:delivered` for what it received, then flushes the outbox.
5. Realtime events that arrive during the sync are merged by `seq` (duplicates ignored, because the store is keyed by message id).

**Gap detection while connected:** if a `message:new` arrives with `seq > localLastSeq + 1`, the client immediately fetches the missing range with `afterSeq`.

### 9.4 Creating a group / adding members

1. `POST /conversations` creates the conversation, participants (creator is `OWNER`), and a `SYSTEM` message.
2. Server makes the members' live sockets join the room: `io.in('user:' + id).socketsJoin('conv:' + convId)` (works across instances with the Redis adapter).
3. Server emits `conversation:created` to each member's personal room.
4. When a member is removed: `socketsLeave`, then `conversation:removed` to that user and `conversation:updated` to the rest.

### 9.5 Typing indicator

- Client emits `typing:start` while the user types (throttled to once per 3 s) and `typing:stop` on send, blur or 5 s idle.
- Server verifies membership, then broadcasts to the room except the sender. Nothing is stored.
- Receiving client shows "typing..." and clears it after 5 s with no refresh (protects against a lost `typing:stop`).

## 10. Presence Design (Redis)

**Requirement:** a user is online if at least one of their sockets is alive; multi-device and server crashes must not leave users stuck online.

**Data structure:** one sorted set per user. Member = socket id, score = expiry timestamp (ms).

```text
ZADD   presence:{userId}  <now+60s>  <socketId>    # on connect and on every presence:ping
ZREM   presence:{userId}  <socketId>               # on disconnect
ZREMRANGEBYSCORE presence:{userId} -inf <now>      # lazy cleanup of dead sockets
ZCOUNT presence:{userId} <now> +inf                # > 0 means online
```

**Transitions:**

- offline to online (first live socket): broadcast `presence:update { online: true }`.
- online to offline (last socket removed or expired): set `lastSeen:{userId}` in Redis, broadcast `presence:update { online: false, lastSeenAt }`.
- A crashed instance never sends disconnects, so its sockets expire after 60 s. A small sweeper (the `presence-sweep` worker job) checks users in the `presence:active` set and emits the offline transition.

**Broadcast scope:** only to rooms the user belongs to (`conv:*` rooms), never to everyone.

## 11. Redis Key Reference

| Key | Type | TTL | Purpose |
| --- | --- | --- | --- |
| `presence:{userId}` | ZSET | none (lazy cleanup) | live sockets per user |
| `presence:active` | SET | none | users believed online, used by the sweeper |
| `lastSeen:{userId}` | STRING (ms) | 7 d | last seen timestamp, flushed to Postgres by the worker |
| `lastSeen:dirty` | SET | none | users whose last seen needs flushing |
| `rl:http:{ip}:{route}` | counter | window | HTTP rate limiting |
| `rl:sock:{userId}:{event}` | counter | window | socket event rate limiting |
| `login:fail:{email}` | counter | 15 min | account lockout |
| `bull:*` | BullMQ | managed | job queues |
| Socket.IO adapter channels | pub/sub | n/a | cross-instance event fan-out |

**Rate limits (starting values):** `message:send` 20 per 10 s per user; `typing:*` 10 per 10 s; REST general 100 per minute per IP; auth routes as in section 7.2.

## 12. Workers

**Runtime:** `apps/worker`, BullMQ, connected to the same Redis and PostgreSQL. It is a separate container so API instances stay focused on traffic. All jobs are idempotent and retried with exponential backoff (3 attempts); failed jobs stay inspectable.

| Job | Schedule | What it does | MVP? |
| --- | --- | --- | --- |
| `last-seen-flush` | every 30 s | reads `lastSeen:dirty`, bulk-updates `User.lastSeenAt` in one SQL statement, clears processed ids | Yes |
| `session-cleanup` | hourly | deletes sessions where `expiresAt < now() - 7 days` or revoked more than 7 days ago | Yes |
| `unread-reconcile` | nightly | recomputes `Participant.unreadCount` as the count of messages with `seq > lastReadSeq`, from other senders, not deleted, and fixes drift | Yes (small) |
| `presence-sweep` | every 30 s | finds users in `presence:active` with no live sockets and emits the offline transition through the Redis emitter | Yes |
| `offline-notification` | event driven | sends a push/email when a message is sent to an offline user | Post-MVP |
| `media-processing` | event driven | thumbnails for attachments | Post-MVP |

**Why last-seen goes through a worker:** writing `lastSeenAt` to PostgreSQL on every connect/disconnect/ping would hammer the database. Redis absorbs the writes and the worker batches them.

**Emitting from a worker:** the worker uses `@socket.io/redis-emitter` to publish events (for example `presence:update`) to rooms without holding any sockets.

## 13. Frontend Design

### 13.1 Pages and layout

| Route | Screen |
| --- | --- |
| `/login`, `/register` | auth forms |
| `/` | two-pane layout: sidebar (chat list, search) + conversation pane |
| `/c/:conversationId` | selected conversation (also the mobile single-pane route) |
| Modals | New direct chat (user search), New group, Group info / members, Profile |

### 13.2 Component tree

```text
App
  AuthGate
    ChatLayout
      Sidebar
        SearchBox / UserSearchResults
        ConversationList -> ConversationItem (avatar, last message, unread badge, presence dot)
      ConversationPane
        ConversationHeader (name, presence / typing text, group info button)
        MessageList (virtualized, infinite scroll upwards)
          MessageBubble (status ticks, reply preview, delete menu)
        TypingIndicator
        Composer (textarea, reply bar, send)
      ConnectionBanner ("Reconnecting...")
```

### 13.3 State management

| State | Where | Notes |
| --- | --- | --- |
| Server data (profile, user search, conversation list, history pages) | TanStack Query | cache keyed by resource |
| Messages per conversation | Zustand store `messages[convId]` as a map by id, sorted by seq | updated by both history fetches and socket events |
| Outbox (pending/failed messages) | Zustand store, persisted to `sessionStorage` | flushed on reconnect |
| Connection status, typing map, presence map | Zustand | ephemeral |
| Access token | memory only | refresh cookie handles persistence |

### 13.4 Client behaviors that matter

- **Optimistic send:** create a local message with `status: sending`, replace on ack.
- **Status ticks:** sending (clock), sent (1 tick), delivered (2 ticks), read (2 colored ticks), failed (retry icon). Derived from the other member's watermarks.
- **Auto read marking:** when the pane is visible and scrolled near the bottom, emit `conversation:read` (debounced 300 ms).
- **Infinite scroll:** `GET messages?beforeSeq=` when the user scrolls near the top; keep scroll position stable.
- **Reconnect logic:** Socket.IO built-in reconnection with backoff, then run the gap-fill procedure (section 9.3), show a banner while disconnected.
- **Duplicate guard:** messages are stored by id; an event for an existing id only updates fields.
- **Multi-tab:** each tab has its own socket; acceptable for the MVP.

## 14. Security Checklist

| Area | Measure |
| --- | --- |
| Passwords | argon2id, never logged |
| Tokens | short-lived access JWT, rotating hashed refresh token in httpOnly cookie, reuse detection |
| Sockets | JWT checked at handshake, session revocation checked, disconnect on token expiry |
| Authorization | every service call checks participant membership; return 404 for unknown conversations to avoid leaking existence |
| Input | Zod on every REST body, query and socket payload; length limits; content stored as text and escaped on render (no `dangerouslySetInnerHTML`) |
| Abuse | rate limits on HTTP and socket events, account lockout on repeated login failure |
| Transport | HTTPS/WSS in production, `helmet`, strict CORS allowlist, CSRF protection for the cookie endpoints (SameSite plus an origin check) |
| Secrets | only in environment variables, `.env.example` committed, `.env` ignored |
| Data | parameterized queries via Prisma; no sensitive fields in logs |

## 15. Configuration and Deployment

### 15.1 Environment variables

```bash
# shared
NODE_ENV=development
DATABASE_URL=postgresql://chat:chat@postgres:5432/chat
REDIS_URL=redis://redis:6379

# api
PORT=3000
JWT_ACCESS_SECRET=change-me-long-random
JWT_ACCESS_TTL_SECONDS=900
REFRESH_TTL_DAYS=30
CORS_ORIGIN=http://localhost:8080
LOG_LEVEL=info

# web (build time)
VITE_API_URL=/api/v1
```

Environment is parsed once at startup with a Zod schema; the process exits with a clear message if something is missing.

### 15.2 Docker Compose (sketch)

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_USER: chat, POSTGRES_PASSWORD: chat, POSTGRES_DB: chat }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U chat"], interval: 5s, retries: 10 }
  redis:
    image: redis:7
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, retries: 10 }
  migrate:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: npx prisma migrate deploy
    depends_on: { postgres: { condition: service_healthy } }
  api1: &api
    build: { context: ., dockerfile: apps/api/Dockerfile }
    env_file: .env
    depends_on: { migrate: { condition: service_completed_successfully }, redis: { condition: service_healthy } }
  api2: *api
  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    env_file: .env
    depends_on: { migrate: { condition: service_completed_successfully } }
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
  nginx:
    image: nginx:alpine
    ports: ["8080:80"]
    volumes: [./infra/nginx.conf:/etc/nginx/nginx.conf:ro]
    depends_on: [api1, api2, web]
volumes: { pgdata: {} }
```

**nginx** proxies `/api/` and `/socket.io/` to the `api1`/`api2` upstream (with `Upgrade`/`Connection` headers for WebSockets) and everything else to `web`. Because the Redis adapter handles cross-instance delivery and Socket.IO is configured with the `websocket` transport first, sticky sessions are not required (if you allow polling fallback, enable `ip_hash` or sticky cookies).

### 15.3 Graceful shutdown (API)

On `SIGTERM`: stop accepting new connections, mark `/ready` unhealthy, close Socket.IO (clients reconnect to another instance), wait for in-flight transactions, close Redis and Prisma, then exit. Set a 15 s hard timeout.

## 16. Testing Strategy

| Level | Tool | What to cover |
| --- | --- | --- |
| Unit | Vitest | services: idempotency, seq assignment, status derivation, direct key generation, rate limiter |
| Integration (REST) | Vitest + Supertest + test Postgres/Redis | register/login/refresh rotation and reuse detection, conversation rules, pagination, authorization (403/404) |
| Integration (realtime) | Vitest + `socket.io-client` | handshake auth, send/ack, broadcast to other client, duplicate send returns same message, typing, delivered/read status |
| Multi-instance | two API instances in the test | sender on instance A, recipient on instance B receives `message:new` |
| Reconnect | client test | disconnect, send from another user, reconnect, gap fill returns exactly the missed messages in order |
| Concurrency | script | 50 concurrent sends in one conversation yield seq 1..50 with no gaps or duplicates |
| Load | k6 | ramp to 1,000 sockets, each sending 1 msg per 5 s, record p95 ack latency and p95 delivery latency; save results in the README |
| E2E (optional) | Playwright | two browser contexts chatting |

**CI (GitHub Actions):** install, lint, typecheck, `prisma migrate`, unit and integration tests with Postgres and Redis service containers.

## 17. Observability

- **Logging:** pino JSON logs with `requestId` (HTTP) and `socketId`/`userId` (sockets). Log connect, disconnect (with reason), auth failures, rate limit hits, and errors.
- **Health:** `/health` (liveness), `/ready` (Postgres and Redis ping).
- **Metrics (nice to have):** `prom-client` exposing `/metrics`: connected sockets gauge, messages sent counter, send latency histogram, ack failures, queue depth.
- **Tracing the message path:** include `messageId` and `conversationId` in logs at each step.

## 18. Delivery Plan to the MVP

Each milestone ends with something runnable and a clear acceptance check. Time estimates assume part-time work; adjust to your pace.

| # | Milestone | Tasks | Done when | Est. |
| --- | --- | --- | --- | --- |
| M0 | Project setup | monorepo, TypeScript, lint, Docker Compose with Postgres + Redis, env validation, `/health`, contracts package | `docker compose up` starts infra; `/health` returns ok | 1-2 d |
| M1 | Database | Prisma schema, first migration, seed script (5 users, sample chats) | migration runs clean; seed works | 1 d |
| M2 | Auth | register, login, refresh with rotation, logout, auth middleware, rate limits | tests for login, refresh rotation, reuse detection pass | 2-3 d |
| M3 | Users and conversations (REST) | profile, user search, create direct/group, members, chat list, history with pagination | can create chats and list/paginate via REST tests | 3 d |
| M4 | Realtime core | Socket.IO server, handshake auth, rooms, `message:send` transaction + ack, `message:new` broadcast, idempotency | two socket clients exchange messages; duplicate send is a no-op | 3-4 d |
| M5 | Status and sync | delivered/read watermarks, `unreadCount`, delete message, gap-fill endpoint and client logic | reconnect test passes; statuses update correctly | 3 d |
| M6 | Presence and typing | Redis presence, typing events, last seen | presence correct with multiple sockets/tabs; dead sockets expire | 2 d |
| M7 | Frontend MVP | auth pages, chat list, conversation pane, composer, optimistic send, outbox, status ticks, typing, presence, reconnect banner | two browsers can chat end to end | 5-7 d |
| M8 | Scale-out and workers | Redis adapter, 2 API instances behind nginx, worker app with jobs from section 12, graceful shutdown | message crosses instances; jobs visible in logs | 3 d |
| M9 | Quality and showcase | integration tests complete, k6 load test, CI, README with diagram, design decisions, screenshots/GIF, optional deployment | all MVP acceptance criteria green; README done | 3-4 d |

**Rule to stay finishable:** do not start a milestone until the previous one is demonstrable. If time runs short, M0-M6 plus a minimal UI is already a strong backend portfolio piece; M8 and M9 turn it into an excellent one.

## 19. MVP Definition of Done

- [ ] A new user can register, log in, and stay logged in across token expiry
- [ ] Two users can start a direct chat and exchange messages in realtime in two browsers
- [ ] Group chat works: create, rename, add/remove members, leave
- [ ] Sent, delivered and read states are correct for direct chats
- [ ] Typing indicator and online/last seen work, including with two tabs
- [ ] Killing the network, sending messages from the other side, then restoring it delivers all missed messages in order, once
- [ ] Retrying the same `clientMessageId` never creates a duplicate
- [ ] Messages reach users connected to different API instances
- [ ] Non-members cannot read or send in a conversation (tested)
- [ ] `docker compose up` starts the whole system; migrations run automatically
- [ ] Integration tests and CI pass; load test results recorded
- [ ] README has: overview, architecture diagram, run instructions, feature list, design decisions, load test numbers, screenshots

## 20. README Outline

1. Title, one-line pitch, badges (CI), demo GIF
2. Features
3. Architecture diagram and short explanation
4. Tech stack
5. Quick start (`cp .env.example .env`, `docker compose up`, URL)
6. Key design decisions: persist-then-broadcast, `seq` ordering, idempotency, reconnect sync, presence in Redis, scaling with the Redis adapter
7. API and socket contract summary (link to the contracts package)
8. Testing and load test results (table with p50/p95 latency and max sockets)
9. Known limitations and what I would do at larger scale
10. Project structure

## 21. Risks and Post-MVP Roadmap

### 21.1 Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scope creep | features outside section 2 are blocked until the MVP checklist is complete |
| Hot conversation row lock (`lastSeq` update) under heavy group traffic | acceptable for MVP; at scale move seq generation to Redis `INCR` or a per-conversation queue |
| Large groups make fan-out and status expensive | cap group size (for example 256) in the MVP |
| Presence storms (many users flipping online/offline) | broadcast only to shared conversation rooms; debounce offline transitions by 5-10 s |
| Frontend consumes most of the time | keep UI plain, use a small component library, spend polish time on the README instead |

### 21.2 Post-MVP ideas (ordered by value for the portfolio)

1. Attachments with presigned S3/MinIO uploads and a media worker
2. Message edit and reactions
3. Push notifications via an `offline-notification` worker
4. Full-text search (PostgreSQL FTS)
5. Prometheus + Grafana dashboard
6. Cursor-based chat list and virtualized sidebar for thousands of chats
7. Moving messages to a wide-column store as a documented scale-out path
8. End-to-end encryption (key bundles, ciphertext only on the server)
