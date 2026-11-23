# Frontend Integration Guide — REST API & Realtime (Socket.IO)

This document is the complete reference for frontend developers integrating with the
Realtime Messaging System backend. It covers every HTTP endpoint with request/response
examples, all error codes, authentication flows, rate limits, and every realtime (Socket.IO)
event with example payloads.

- **REST base URL:** `http://localhost:3000/api/v1` (development)
- **Socket.IO endpoint:** `http://localhost:3000` (same host/port as REST, **WebSocket transport only**)
- **Content type:** `application/json`
- **Success responses:** the endpoint's resource JSON directly.
- **Error responses:** always `{ "error": { ... } }` — see [Errors](#errors).

---

## Table of Contents

1. [Authentication Model](#authentication-model)
2. [Errors](#errors)
3. [Rate Limits](#rate-limits)
4. [Endpoints](#endpoints)
   - [System & Health](#system--health)
   - [Auth](#auth)
   - [Users](#users)
   - [Conversations](#conversations)
   - [Messages](#messages)
   - [Presence](#presence)
5. [Realtime (Socket.IO)](#realtime-socketio)
6. [Client Integration Recipes](#client-integration-recipes)

---

## Authentication Model

The API uses a short-lived **JWT access token** (bearer) plus a long-lived **refresh token**
delivered as an `HttpOnly` cookie scoped to `/api/v1/auth`.

- **Access token** — send as `Authorization: Bearer <accessToken>` on every protected request
  and in the Socket.IO handshake. Default TTL is **900 seconds (15 min)**, configurable via
  `JWT_ACCESS_TTL_SECONDS`.
- **Refresh token** — stored in an `HttpOnly`, `SameSite=Lax` cookie named `refreshToken`,
  scoped to `Path=/api/v1/auth`, `Max-Age` = `REFRESH_TTL_DAYS` (default 30 days). The frontend
  **cannot read this cookie from JS**; it only needs to send credentials to the auth endpoints
  and the browser handles the cookie. Refresh is a **rotation** flow: each `/auth/refresh`
  returns a new access token and a new refresh cookie.
- **Refresh reuse detection** — if a refresh token is replayed after rotation, the entire
  session family is revoked and the request fails with `401 UNAUTHENTICATED`.

> **Token expiry handling:** When the access token expires, protected REST calls return
> `401` with code `TOKEN_EXPIRED`. Call `POST /auth/refresh`, then retry once. Socket.IO
> connects with `connect_error` message `TOKEN_EXPIRED`.

### Typical login flow

```
POST /auth/login  { email, password }
   -> 200 { user, accessToken }  + Set-Cookie: refreshToken=...
   -> keep accessToken in memory, store user
   -> use Authorization: Bearer <accessToken> for REST
   -> connect Socket.IO with auth: { token: accessToken }
```

---

## Errors

Every error response shares one envelope. `requestId` is always present and correlates with the
server log. `details` is optional and its shape depends on the error.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": [ { "path": "email", "message": "Invalid email" } ],
    "requestId": "req-7f3c1a9e"
  }
}
```

### Error codes

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `VALIDATION_ERROR` | 400 | Request body/query failed schema validation. `details` is an array of `{ path, message }`. |
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired/revoked access token, or bad login credentials. |
| `TOKEN_EXPIRED` | 401 | Access token expired (REST) or socket token expired (Socket.IO `connect_error`). |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g., non-admin group action, deleting another user's message). |
| `NOT_FOUND` | 404 | Resource does not exist or is not visible to the caller. |
| `CONFLICT` | 409 | Uniqueness/state conflict. `details` is often `{ "field": "email" }` or `{ "field": "username" }`. |
| `RATE_LIMITED` | 429 | Too many requests. Response includes a `Retry-After` header (seconds). |
| `INTERNAL` | 500 | Unexpected server error. |

### Common validation example

Request:

```json
{ "email": "not-an-email", "username": "a", "password": "short", "displayName": " " }
```

Response `400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": [
      { "path": "email", "message": "Invalid email" },
      { "path": "username", "message": "String must contain at least 3 character(s)" },
      { "path": "password", "message": "String must contain at least 8 character(s)" },
      { "path": "displayName", "message": "String must contain at least 1 character(s)" }
    ],
    "requestId": "req-1a2b3c4d"
  }
}
```

### Conflict example (duplicate registration)

Response `409`:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Email already in use",
    "details": { "field": "email" },
    "requestId": "req-9f8e7d6c"
  }
}
```

### Not-found example

Response `404`:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /api/v1/unknown not found",
    "details": null,
    "requestId": "req-4c5d6e7f"
  }
}
```

---

## Rate Limits

Rate limiting is **per client IP** (via Redis). Limits reset on a sliding window.

| Scope | Default | Applies to |
|-------|---------|------------|
| `api` | 100 requests / 60s | All `/api/v1/*` routes |
| `register` | 10 / 60s | `POST /api/v1/auth/register` |
| `login` | 10 / 60s | `POST /api/v1/auth/login` |
| `loginFailures` | 5 / 15 min | Failed login attempts per email |

When a limit is exceeded the API returns `429` with a `Retry-After` header (seconds) and body:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests", "details": null, "requestId": "req-..." } }
```

Socket.IO has its own limits: **20 messages / 10s** per user for `message:send`, and **10 typing events / 10s**. Exceeding the message limit emits a `rate_limited` event **and** returns an error ack with code `RATE_LIMITED`.

---

## Endpoints

All endpoints below are under `/api/v1` unless prefixed otherwise.

### System & Health

#### `GET /health`
Public. Liveness probe.

**200**
```json
{ "status": "ok", "uptime": 42, "instanceId": "api-1" }
```

#### `GET /ready`
Public. Readiness probe — checks Postgres and Redis.

**200**
```json
{ "status": "ready" }
```

**503** (dependency down)
```json
{ "status": "not_ready", "checks": { "postgres": false, "redis": true } }
```

**503** (shutting down)
```json
{ "status": "shutting_down" }
```

---

### Auth

#### `POST /api/v1/auth/register`
Create an account and start a session.

**Request body**
```json
{
  "email": "new.user@example.com",
  "username": "new_user",
  "password": "Password123!",
  "displayName": "New User"
}
```

Rules: `email` valid & lowercased; `username` 3–20 chars, `[a-z0-9_]`, lowercased; `password` 8–72 chars; `displayName` 1–50 chars.

**201**
```json
{
  "user": {
    "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "email": "new.user@example.com",
    "username": "new_user",
    "displayName": "New User",
    "avatarUrl": null,
    "createdAt": "2026-11-23T09:00:00.000Z"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

Also sets `Set-Cookie: refreshToken=<token>; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000`.

**Errors:** `400 VALIDATION_ERROR`, `409 CONFLICT` (`details.field = "email"` or `"username"`), `429 RATE_LIMITED`.

---

#### `POST /api/v1/auth/login`
Authenticate and start a session.

**Request body**
```json
{ "email": "new.user@example.com", "password": "Password123!" }
```

**200**
```json
{
  "user": {
    "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "email": "new.user@example.com",
    "username": "new_user",
    "displayName": "New User",
    "avatarUrl": null,
    "createdAt": "2026-11-23T09:00:00.000Z"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

Also sets the `refreshToken` cookie.

**Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED` ("Invalid email or password"), `429 RATE_LIMITED` (per-IP login limit, or after 5 failed attempts for that email with `Retry-After`).

---

#### `POST /api/v1/auth/refresh`
Rotate the session using the `refreshToken` cookie. No body required (cookie-based).

**200**
```json
{ "accessToken": "eyJhbGciOiJIUzI1NiJ9..." }
```

Also sets a new `refreshToken` cookie.

**Errors:** `401 UNAUTHENTICATED` ("Invalid refresh token") when the cookie is missing, expired, already rotated, or revoked. The cookie is cleared on failure.

---

#### `POST /api/v1/auth/logout`
Revoke the current refresh session and clear the cookie. Always returns `204`.

**204 No Content** (empty body)

---

### Users

All user routes require `Authorization: Bearer <accessToken>`.

#### `GET /api/v1/users/me`
Current authenticated user's full profile.

**200**
```json
{
  "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "email": "new.user@example.com",
  "username": "new_user",
  "displayName": "New User",
  "avatarUrl": null,
  "createdAt": "2026-11-23T09:00:00.000Z"
}
```

**Errors:** `401 UNAUTHENTICATED`, `401 TOKEN_EXPIRED`.

---

#### `PATCH /api/v1/users/me`
Update your own profile. At least one field is required.

**Request body** (all optional, but at least one required)
```json
{ "displayName": "Updated Name", "avatarUrl": "https://example.com/avatar.png" }
```

Rules: `displayName` 1–50 chars; `avatarUrl` must be a valid `https://` URL (≤ 500 chars) or `null` to clear it.

**200**
```json
{
  "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "email": "new.user@example.com",
  "username": "new_user",
  "displayName": "Updated Name",
  "avatarUrl": "https://example.com/avatar.png",
  "createdAt": "2026-11-23T09:00:00.000Z"
}
```

**Errors:** `400 VALIDATION_ERROR` (empty body, blank name, non-HTTPS avatar), `401`.

---

#### `GET /api/v1/users?q=<query>&limit=<n>`
Search users by username or display name (case-insensitive). Excludes yourself. Results sorted by username ascending.

**Query params**
- `q` (required): 2+ characters.
- `limit` (optional): 1–20, default `10`.

**200** — a JSON array of public user objects (no `email`):
```json
[
  {
    "id": "9b2f7c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
    "username": "alice",
    "displayName": "Alice",
    "avatarUrl": null,
    "createdAt": "2026-11-20T10:00:00.000Z"
  }
]
```

**Errors:** `400 VALIDATION_ERROR` (`q` too short or `limit` out of range), `401`.

---

#### `GET /api/v1/users/:id`
Public profile of any user.

**200**
```json
{
  "id": "9b2f7c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
  "username": "alice",
  "displayName": "Alice",
  "avatarUrl": null,
  "createdAt": "2026-11-20T10:00:00.000Z"
}
```

**Errors:** `401`, `404 NOT_FOUND`.

---

### Conversations

All conversation routes require auth. Conversation DTOs are viewer-specific (unread counts, read watermarks, peer presence differ per caller).

#### Conversation DTO shape

```json
{
  "id": "c1f2a3b4-0000-4000-8000-000000000001",
  "type": "DIRECT",
  "name": null,
  "members": [
    { "userId": "3f2504e0-...", "role": "OWNER", "displayName": "Alice", "avatarUrl": null },
    { "userId": "9b2f7c1e-...", "role": "MEMBER", "displayName": "Bob", "avatarUrl": null }
  ],
  "lastSeq": 5,
  "memberCount": 2,
  "lastMessage": {
    "id": "m-0005",
    "conversationId": "c1f2a3b4-0000-4000-8000-000000000001",
    "seq": 5,
    "senderId": "9b2f7c1e-...",
    "type": "TEXT",
    "content": "See you at 5?",
    "clientMessageId": "8f14e45f-ceea-467f-a1d2-3b6c7d8e9f0a",
    "replyTo": null,
    "createdAt": "2026-11-23T10:15:00.000Z",
    "deletedAt": null
  },
  "unreadCount": 2,
  "myLastReadSeq": 3,
  "receipts": { "deliveredUpTo": 5, "readUpTo": 3 },
  "peerPresence": { "online": true, "lastSeenAt": null }
}
```

Field notes:
- `type`: `"DIRECT"` or `"GROUP"`.
- `members`: active participants only. For DIRECT conversations, this lists the other participants (not you). `role` is `OWNER` | `ADMIN` | `MEMBER`.
- `lastSeq`: highest message sequence in the conversation.
- `lastMessage`: the most recent message (TEXT or SYSTEM) or `null`.
- `unreadCount` / `myLastReadSeq`: **your** unread state.
- `receipts`: aggregate peer delivery/read watermarks — `deliveredUpTo` / `readUpTo` = the minimum across peers (i.e., what the slowest peer has seen). Use with `seq` to derive a message's status: `read` if `readUpTo >= seq`, `delivered` if `deliveredUpTo >= seq`, else `sent`.
- `peerPresence`: only for DIRECT conversations; `{ online, lastSeenAt }`. `lastSeenAt` is `null` while online. For groups this is `null`.

#### Message DTO shape

```json
{
  "id": "m-0005",
  "conversationId": "c1f2a3b4-0000-4000-8000-000000000001",
  "seq": 5,
  "senderId": "9b2f7c1e-...",
  "type": "TEXT",
  "content": "See you at 5?",
  "clientMessageId": "8f14e45f-ceea-467f-a1d2-3b6c7d8e9f0a",
  "replyTo": {
    "id": "m-0004",
    "senderId": "3f2504e0-...",
    "preview": "Are we still meeting today?"
  },
  "createdAt": "2026-11-23T10:15:00.000Z",
  "deletedAt": null
}
```

Field notes:
- `senderId` is `null` for SYSTEM messages.
- `content` is `null` for deleted messages (tombstone) and always a string for SYSTEM.
- `replyTo.preview` is the first 80 chars of the replied-to message, or `null` if that message is deleted.
- `seq` is a per-conversation monotonic integer, starting at 1.

---

#### `GET /api/v1/conversations`
List your active conversations, most-recently-active first. Cursor-paginated.

**Query params**
- `limit` (optional): 1–50, default `30`.
- `cursor` (optional): opaque base64url string from a previous `nextCursor`. Do not construct or parse it yourself.

**200**
```json
{
  "items": [
    { "id": "c1f2a3b4-...", "type": "DIRECT", "name": null, "members": [], "lastSeq": 5, "memberCount": 2, "lastMessage": {}, "unreadCount": 2, "myLastReadSeq": 3, "receipts": { "deliveredUpTo": 5, "readUpTo": 3 }, "peerPresence": { "online": false, "lastSeenAt": "2026-11-23T09:55:00.000Z" } }
  ],
  "nextCursor": "eyJ1c2VySWQiOiI5YjJmMWMxZSIsImxhc3RNZXNzYWdlQXQiOiIyMDI2LTExLTIzVDEwOjE1OjAwLjAwMFoiLCJpZCI6Im0tMDAwNSJ9"
}
```

- `nextCursor` is `null` on the last page. When non-null, pass it as `?cursor=` to fetch the next page.
- Only conversations with at least one message appear (a freshly created direct conversation is included with `lastMessage: null` until it has a message).

**Errors:** `400 VALIDATION_ERROR` (bad `limit` or malformed cursor), `401`.

---

#### `POST /api/v1/conversations`
Open a direct conversation or create a group.

**Direct (1:1)**
```json
{ "type": "DIRECT", "userId": "9b2f7c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b" }
```

**Group**
```json
{
  "type": "GROUP",
  "name": "Project Team",
  "memberIds": ["9b2f7c1e-...", "c3d4e5f6-..."]
}
```

Rules: group `name` 1–100 chars; `memberIds` must contain 1–255 other users (creator is added as `OWNER` automatically). Duplicate IDs are deduped.

**Responses**
- **201** — a new conversation was created (returns the Conversation DTO).
- **200** — a DIRECT conversation already existed between you and `userId` (returns the existing DTO).

Direct conversations are idempotent: opening the same pair from either side returns the same conversation.

**Errors:** `400 VALIDATION_ERROR` (self-conversation, empty group, group with only yourself, > 255 members), `401`, `404 NOT_FOUND` (unknown user).

---

#### `GET /api/v1/conversations/:id`
Get one conversation by ID. Only visible to active members.

**200** — Conversation DTO (see above).

**Errors:** `401`, `404 NOT_FOUND` (not a member, left, or does not exist).

---

#### `PATCH /api/v1/conversations/:id`
Rename a group. Only `OWNER` or `ADMIN` can rename. Direct conversations cannot be renamed.

**Request body**
```json
{ "name": "New Project Team Name" }
```

**200** — updated Conversation DTO. A SYSTEM message (`"<actor> renamed the group"`) is added.

**Errors:** `400 VALIDATION_ERROR` (blank name, or target is a DIRECT conversation), `401`, `403 FORBIDDEN` (member lacks admin rights), `404 NOT_FOUND`.

---

#### `POST /api/v1/conversations/:id/members`
Add members to a group. Only `OWNER` or `ADMIN`. Re-adding a former member rejoins them (with fresh history watermarks). Groups are capped at 256 active members.

**Request body**
```json
{ "userIds": ["9b2f7c1e-...", "c3d4e5f6-..."] }
```

**200** — updated Conversation DTO. A SYSTEM message (`"<actor> added <names>"`) is added.

**Errors:** `400 VALIDATION_ERROR` (target is a DIRECT conversation), `401`, `403 FORBIDDEN`, `404 NOT_FOUND` (conversation or unknown user), `409 CONFLICT` (would exceed 256 members).

---

#### `DELETE /api/v1/conversations/:id/members/:userId`
Remove a member. Self-removal is allowed for anyone; removing others requires `OWNER`/`ADMIN` (and an `ADMIN` cannot remove the `OWNER` or another `ADMIN`). Direct conversations cannot be used.

**204 No Content** on success. A SYSTEM message (`"<actor> removed <name>"` or `"<name> left the group"`) is added, and the affected member receives a `conversation:removed` socket event.

**Errors:** `400 VALIDATION_ERROR` (direct conversation), `401`, `403 FORBIDDEN`, `404 NOT_FOUND` (member not found / outsider).

---

#### `POST /api/v1/conversations/:id/leave`
Leave a group (equivalent to removing yourself).

**204 No Content** on success. If the owner leaves, ownership transfers to the oldest admin, else the oldest member.

**Errors:** `400 VALIDATION_ERROR` (direct conversation), `401`, `404 NOT_FOUND` (not a member), `409 CONFLICT` (owner cannot leave when they are the only active member).

---

### Messages

#### `GET /api/v1/conversations/:id/messages`
Paginate message history. Two modes:

- **Newest-first paging (default):** omit `afterSeq`. Returns the latest `limit` messages in descending `seq` order. Use `beforeSeq` to page backwards (older).
- **Gap-fill / forward paging:** pass `afterSeq`. Returns messages with `seq > afterSeq` in ascending order (use this to catch up after a reconnect).

**Query params**
- `limit` (optional): 1–100, default `30`.
- `beforeSeq` (optional): return messages with `seq < beforeSeq` (older).
- `afterSeq` (optional): return messages with `seq > afterSeq` (newer).
- `beforeSeq` and `afterSeq` are mutually exclusive.

Only messages with `seq >= your joinedAtSeq` are returned (you cannot see history from before you joined).

**200 (newest-first)**
```json
{
  "items": [
    { "id": "m-0030", "conversationId": "c1f2a3b4-...", "seq": 30, "senderId": "3f2504e0-...", "type": "TEXT", "content": "Latest message", "clientMessageId": "...", "replyTo": null, "createdAt": "2026-11-23T10:30:00.000Z", "deletedAt": null }
  ],
  "hasMore": true
}
```

- In newest-first mode, `items` are sorted by `seq` descending.
- In `afterSeq` mode, `items` are sorted by `seq` ascending.
- `hasMore` indicates whether more messages exist in the requested direction.

**Errors:** `400 VALIDATION_ERROR` (bad params, or both `beforeSeq` and `afterSeq`), `401`, `404 NOT_FOUND` (not a member).

---

#### `POST /api/v1/conversations/:id/read`
Mark the conversation as read up to a sequence (REST alternative to the socket `conversation:read`). Updates your read watermark and unread count.

**Request body**
```json
{ "upToSeq": 12 }
```

**204 No Content** on success.

**Errors:** `400 VALIDATION_ERROR` (`upToSeq` exceeds the conversation's `lastSeq`), `401`, `403 FORBIDDEN` (not an active member), `404 NOT_FOUND` (conversation not found).

---

#### `DELETE /api/v1/messages/:id`
Soft-delete your own message (tombstone). Idempotent: deleting an already-deleted message still returns `204`. System messages cannot be deleted.

**204 No Content** on success. Other participants receive a `message:deleted` socket event.

**Errors:** `400 VALIDATION_ERROR` (system message), `401`, `403 FORBIDDEN` (not your message), `404 NOT_FOUND`.

---

### Presence

#### `GET /api/v1/presence?ids=<id1,id2,...>`
Get online/last-seen status for up to 50 users (comma-separated IDs).

**200**
```json
{
  "items": [
    { "userId": "9b2f7c1e-...", "online": true, "lastSeenAt": null },
    { "userId": "c3d4e5f6-...", "online": false, "lastSeenAt": "2026-11-23T09:55:00.000Z" }
  ]
}
```

- `lastSeenAt` is `null` while the user is online.
- Unknown IDs are omitted from `items`.

**Errors:** `400 VALIDATION_ERROR` (missing `ids` or > 50 ids), `401`.

---

## Realtime (Socket.IO)

The realtime layer uses **Socket.IO v4** over **WebSocket transport only** (polling fallback is
disabled). Connect to the same host/port as the REST API.

### Connection

```js
import { io } from 'socket.io-client'

const socket = io('http://localhost:3000', {
  transports: ['websocket'],
  auth: { token: accessToken }, // JWT access token
})
```

On success the server emits a `ready` event after joining the user's rooms.

```json
// event: "ready"
{ "serverTime": "2026-11-23T10:00:00.000Z" }
```

After `ready`, the socket is automatically a member of:
- `user:<yourUserId>` room
- `conv:<conversationId>` room for each active conversation you belong to

### Connection errors

If authentication fails, the socket emits `connect_error` with a message:

| `connect_error` message | Cause |
|-------------------------|-------|
| `UNAUTHENTICATED` | Missing token, invalid token, or revoked session |
| `TOKEN_EXPIRED` | Access token expired — refresh and reconnect |
| `INTERNAL` | Unexpected server error |

The socket is disconnected when its access token expires (server-side timer), so refresh proactively.

### Client → Server events

| Event | Payload | Ack response |
|-------|---------|--------------|
| `message:send` | `SendMessageInput` | `{ ok: true, data: { message, duplicate } }` or `{ ok: false, error: { code, message } }` |
| `message:delete` | `{ messageId }` | `{ ok: true, data: { messageId, seq } }` |
| `message:delivered` | `{ conversationId, upToSeq }` | `{ ok: true, data: {} }` |
| `conversation:read` | `{ conversationId, upToSeq }` | `{ ok: true, data: { unreadCount } }` |
| `typing:start` | `{ conversationId }` | (no ack) |
| `typing:stop` | `{ conversationId }` | (no ack) |
| `presence:ping` | (none) | (no ack) |

#### `message:send`

```js
const ack = await socket.timeout(5000).emitWithAck('message:send', {
  conversationId: 'c1f2a3b4-...',
  clientMessageId: crypto.randomUUID(), // UUID — idempotency key for retries
  content: 'Hello world',
  replyToId: 'm-0004', // optional
})
```

**Ack (success)**
```json
{
  "ok": true,
  "data": {
    "message": { "id": "m-0031", "conversationId": "c1f2a3b4-...", "seq": 31, "senderId": "3f2504e0-...", "type": "TEXT", "content": "Hello world", "clientMessageId": "8f14e45f-...", "replyTo": null, "createdAt": "2026-11-23T10:31:00.000Z", "deletedAt": null },
    "duplicate": false
  }
}
```

- `duplicate: true` means this `clientMessageId` was already sent (idempotent retry) — the same message is returned.
- Send failures return `{ ok: false, error: { code, message } }` with codes like `VALIDATION_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL`.

All conversation members (including the sender's other devices) receive a `message:new` broadcast when a new (non-duplicate) message is created.

#### `message:delete`

```js
const ack = await socket.timeout(5000).emitWithAck('message:delete', { messageId: 'm-0031' })
```

**Ack (success)**
```json
{ "ok": true, "data": { "messageId": "m-0031", "seq": 31 } }
```

Idempotent: deleting an already-deleted message still returns `ok`. System messages return `VALIDATION_ERROR`.

#### `message:delivered` / `conversation:read`

```js
socket.emit('message:delivered', { conversationId, upToSeq })
socket.emit('conversation:read', { conversationId, upToSeq })
```

Both are monotonic: calling with a lower `upToSeq` than your current watermark is a no-op (still `ok`). `upToSeq` must not exceed the conversation's `lastSeq`.

#### `typing:start` / `typing:stop`

```js
socket.emit('typing:start', { conversationId })
socket.emit('typing:stop', { conversationId })
```

Other members receive a `typing` event. Typing is rate-limited to 10 events / 10s; excess events are silently dropped. Sending a message automatically clears your typing indicator (others receive `typing` with `isTyping: false`).

#### `presence:ping`

Emit every ~25 seconds while connected to keep your presence alive. Presence expires after 60 seconds without a heartbeat. On connect/heartbeat the server emits a `presence:update` to co-members when you come online.

### Server → Client events

#### `ready`
```json
{ "serverTime": "2026-11-23T10:00:00.000Z" }
```

#### `message:new`
```json
{ "message": { "id": "m-0031", "conversationId": "c1f2a3b4-...", "seq": 31, "senderId": "9b2f7c1e-...", "type": "TEXT", "content": "Hello world", "clientMessageId": "8f14e45f-...", "replyTo": null, "createdAt": "2026-11-23T10:31:00.000Z", "deletedAt": null } }
```

#### `message:deleted`
```json
{ "conversationId": "c1f2a3b4-...", "messageId": "m-0031", "seq": 31 }
```

#### `message:status`
Emitted to conversation members when someone advances delivery/read watermarks.

```json
{ "conversationId": "c1f2a3b4-...", "userId": "9b2f7c1e-...", "kind": "delivered", "upToSeq": 31 }
```

`kind` is `"delivered"` or `"read"`. `userId` is the member who advanced.

#### `conversation:created`
Sent to each participant when they are added to a new group (and to the creator).

```json
{ "conversation": { "id": "c1f2a3b4-...", "type": "GROUP", "name": "Project Team", "members": [], "lastSeq": 1, "memberCount": 3, "lastMessage": {}, "unreadCount": 0, "myLastReadSeq": 0, "receipts": { "deliveredUpTo": 0, "readUpTo": 0 }, "peerPresence": null } }
```

#### `conversation:updated`
Sent to the conversation room when a group is renamed or members change.

```json
{ "conversation": { "id": "c1f2a3b4-...", "type": "GROUP", "name": "Renamed", "members": [], "lastSeq": 2, "memberCount": 3, "lastMessage": {}, "unreadCount": 0, "myLastReadSeq": 2, "receipts": { "deliveredUpTo": 2, "readUpTo": 2 }, "peerPresence": null } }
```

#### `conversation:removed`
Sent to a user who was removed from (or left) a group.

```json
{ "conversationId": "c1f2a3b4-..." }
```

#### `typing`
```json
{ "conversationId": "c1f2a3b4-...", "userId": "9b2f7c1e-...", "isTyping": true }
```

#### `presence:update`
Broadcast to all conversations you share with the user when they go online/offline.

```json
{ "userId": "9b2f7c1e-...", "online": true, "lastSeenAt": null }
```

When offline, `lastSeenAt` is an ISO timestamp.

#### `rate_limited`
Emitted when a socket event exceeds its limit (e.g., `message:send`).

```json
{ "event": "message:send", "retryAfterMs": 4200 }
```

---

## Client Integration Recipes

### Sequence numbers & gap recovery

Each message has a per-conversation monotonic `seq`. To detect gaps, track the highest `seq`
you have seen for a conversation. When an incoming `message:new` has `seq > localLastSeq + 1`,
you missed messages — refetch with `GET /conversations/:id/messages?afterSeq=<localLastSeq>&limit=100`
and merge by `id` (sorted by `seq`).

### Sending reliably (outbox pattern)

1. Assign a `clientMessageId` (UUID) and store the message in a local outbox with status `pending`.
2. Emit `message:send` with an ack and a timeout (e.g., 5s).
3. On `ok: true`, mark `sent` and store the returned `message` (authoritative `id`/`seq`).
4. On `ok: false` with a retryable code (`RATE_LIMITED`, `INTERNAL`), retry with exponential backoff (e.g., 500ms, 1s, 2s, 4s — up to ~5 attempts). On `VALIDATION_ERROR` / `FORBIDDEN`, mark `failed`.
5. Because `clientMessageId` is idempotent, re-sending is safe — the server returns `duplicate: true` with the original message if it already succeeded.

### Receiving messages

On `message:new`, append to the conversation's message list if not already present (dedupe by `id`),
update the conversation's `lastSeq`/`lastMessage`, then optionally call `message:delivered` to
acknowledge delivery.

### Read & delivery status

- Show per-message status from the conversation's `receipts` (`readUpTo` / `deliveredUpTo`) vs the
  message's `seq`.
- When the user views a conversation, emit `conversation:read` with the highest visible `seq`
  (or call `POST /conversations/:id/read`).

### Typing indicators

Throttle `typing:start` (e.g., once every 1–2s while the user types) and emit `typing:stop` on
pause or send. Show the indicator for other users from the `typing` event; auto-clear after a few
seconds of inactivity.

### Reconnection

Socket.IO handles reconnection automatically (`reconnection: true`). After the `ready` event,
run a full sync: list conversations (paginate with `cursor`), then for each conversation fetch
messages after your last known `seq`. The `ChatClient` in `@realtime-messaging/client-core`
implements all of this for you if you prefer not to build it from scratch.

### Using the provided client

```ts
import { ChatClient, createMemoryStorage } from '@realtime-messaging/client-core'

const chat = new ChatClient({
  baseUrl: 'http://localhost:3000/api/v1',
  getAccessToken: () => currentAccessToken,
  refreshAccessToken: async () =>
    (await fetch('http://localhost:3000/api/v1/auth/refresh', { method: 'POST' }))
      .json()
      .then((j) => j.accessToken),
  storage: createMemoryStorage(),
})

chat.on('message:new', ({ message }) => {
  /* render */
})
chat.on('presence:update', (p) => {
  /* update avatars */
})

await chat.connect()
await chat.send(conversationId, 'Hello') // queues + sends with retries
await chat.markRead(conversationId, lastSeq)
chat.setTyping(conversationId, true)
```