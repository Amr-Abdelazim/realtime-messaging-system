# Realtime Messaging System: Task Workflow and GitHub Plan

*Step-by-step build guide. One task = one GitHub issue = one branch = one pull request. Companion to the Project Document.*

## 1. How to Use This Document

The Project Document says **what** to build (requirements, schema, API and socket contracts). This document says **in what order** and **how to ship it in small pieces**.

- The work is split into **34 tasks (T00 to T33)** in 7 phases. Each task is small enough to finish in a few hours to 1-2 days.
- Every task has the same layout: branch name, dependencies, goal, checklist, contract/files, tests, "done when", and the PR title.
- Do tasks **in order**. A task may only start when its dependencies are merged into `main`.
- When a task is merged, the project still builds, passes tests and runs. `main` is always working.
- Section references like "Project Doc 6.4" point to the Project Document.

## 2. Decisions Made for You

These choices remove open questions so you can start coding. Change them only with a good reason.

| # | Decision | Reason |
| --- | --- | --- |
| D1 | **Trunk-based flow**: `main` plus short-lived task branches, squash merge | simple, readable history, one commit per task |
| D2 | **Conventional Commits** (`feat(auth): ...`) enforced by commitlint | clean log, readable changelog |
| D3 | **One PR per task**, target under about 400 changed lines | easy self-review, easy revert |
| D4 | **Backend first, then frontend**: tasks T04 to T22 finish the whole backend (verified by tests and `.http` files), then T23 to T29 build the UI | the backend is the showpiece; the UI is built against a stable contract |
| D5 | **Dev mode** runs Postgres and Redis in Docker and the apps on the host with `pnpm dev`; the full Compose stack (2 API instances, nginx, worker, web) arrives in T20 | fast feedback loop first, deployment topology later |
| D6 | **pnpm workspaces**, Node 22 LTS, TypeScript strict, ESM modules | modern defaults, one lockfile |
| D7 | **Express 5** for HTTP (handles async errors natively), **Socket.IO** for realtime | familiar, minimal boilerplate |
| D8 | **Vitest** for all tests; integration tests hit a real Postgres (`chat_test` database) and real Redis, no mocks for infrastructure | tests that match production behavior |
| D9 | **`.http` request files** (VS Code REST Client) under `requests/` and a small **socket CLI script** under `scripts/` for manual testing before the UI exists | lets you demo each backend task without a frontend |
| D10 | **`packages/contracts`** is the single source of truth for DTOs, error codes and socket event types, built with `tsup` | API, worker and web never drift apart |
| D11 | **Test DB reset** by truncating tables between test files (helper in `apps/api/test/helpers/db.ts`) | fast and deterministic |
| D12 | **Version tags** at phase ends: `v0.1.0` (after Phase 1) up to `v1.0.0` (MVP) | visible progress on GitHub |
| D13 | **License:** MIT | standard for portfolio projects |

## 3. GitHub Setup and Workflow

### 3.1 One-time repository setup (do this in T00)

1. Create the repo (public), name of your choice, add description and topics: `nodejs`, `typescript`, `websocket`, `socket-io`, `redis`, `postgresql`, `prisma`, `realtime`, `chat`.
2. Make the first commit directly on `main` (the only exception to the PR rule).
3. **Branch protection on `main`:** require pull request, require status checks (the CI workflow from T04), require linear history, block force pushes. (If you work alone, you can leave "required approvals" at 0.)
4. Enable **"Automatically delete head branches"** and allow **squash merging only**.
5. Create **labels:** `feat`, `fix`, `chore`, `docs`, `test`, `backend`, `frontend`, `infra`, `realtime`, `blocked`, plus one label per phase (`phase-0` to `phase-6`).
6. Create **milestones** named exactly as the phases in section 5 (they track progress bars on GitHub).
7. Create one **issue per task** (T00 to T33) using the issue template below, assigned to the matching milestone. Paste the task's checklist into the issue body.

### 3.2 Branch names

`<type>/<task-id>-<short-name>`, for example `feat/t05-auth-register`, `chore/t04-ci`, `docs/t32-readme`.

### 3.3 Commit messages (Conventional Commits)

```text
<type>(<scope>): <imperative summary, max 72 chars>

[optional body: what and why]
[optional footer: Closes #12]
```

| Type | Use for |
| --- | --- |
| `feat` | new behavior |
| `fix` | bug fix |
| `test` | tests only |
| `docs` | documentation |
| `refactor` | code change without behavior change |
| `chore` | tooling, config, dependencies |
| `ci` | GitHub Actions |
| `perf` | performance |

Scopes: `auth`, `users`, `conversations`, `messages`, `realtime`, `presence`, `worker`, `web`, `db`, `infra`, `contracts`.

Make **several small commits per branch** (for example: schema, service, route, tests). They are squashed on merge, so the final commit message is the **PR title**.

### 3.4 The loop for every task

```bash
# 1. start from a fresh main
git switch main && git pull

# 2. create the task branch
git switch -c feat/t05-auth-register

# 3. work in small commits (stage carefully)
git add -p
git commit -m "feat(auth): add register service"

# 4. keep up to date if main moved
git fetch origin && git rebase origin/main

# 5. push and open the PR
git push -u origin feat/t05-auth-register
gh pr create --fill --label feat,backend --milestone "Phase 1 - Auth"

# 6. CI green, self-review the diff, then squash and merge on GitHub
# 7. clean up
git switch main && git pull && git branch -d feat/t05-auth-register
```

### 3.5 Pull request template (`.github/pull_request_template.md`)

```markdown
## What
One or two sentences about the change. Closes #<issue>.

## How to test
1. Steps or commands (include the .http file or test name)

## Checklist
- [ ] Task checklist in the issue is complete
- [ ] Tests added or updated and passing locally
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] No secrets, no commented-out code, no stray console.log
- [ ] Docs / contracts / .env.example updated if needed
- [ ] Migration included and reversible, if the schema changed
```

### 3.6 Issue template (`.github/ISSUE_TEMPLATE/task.md`)

```markdown
---
name: Task
about: One unit of work from the workflow document
labels: ''
---
**Task ID:** T00
**Branch:** feat/t00-name
**Depends on:** T..

## Goal

## Checklist
- [ ] ...

## Done when
```

### 3.7 Releases and tags

After the last task of a phase is merged: `git tag v0.X.0 && git push --tags`, then create a GitHub Release with auto-generated notes. The tag plan is in section 5.

## 4. Definition of Done for Every Task

A task is finished only when **all** of these are true:

1. Every item in its checklist is ticked.
2. New behavior is covered by tests (unit and/or integration) and the whole suite is green.
3. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass locally and in CI.
4. The contract (Zod schema in `packages/contracts`) exists before or together with the endpoint/event that uses it.
5. There is a way to try it: a `.http` request, a socket CLI command, or (after T23) the UI.
6. Errors use the standard envelope and codes from Project Doc 7.1.
7. `.env.example` and docs are updated if configuration changed.
8. The PR is squash-merged into `main` and the branch is deleted.

## 5. Roadmap Overview

| Phase | Tasks | Outcome | Tag |
| --- | --- | --- | --- |
| **Phase 0 - Foundation** | T00 to T04 | repo, tooling, infra, contracts base, database, CI | `v0.1.0` |
| **Phase 1 - Auth** | T05 to T08 | register, login, refresh rotation, logout, rate limits | `v0.2.0` |
| **Phase 2 - REST core** | T09 to T13 | profile, search, direct and group chats, chat list, history | `v0.3.0` |
| **Phase 3 - Realtime** | T14 to T20 | socket auth, send message, status, delete, typing, presence, sync | `v0.4.0` |
| **Phase 4 - Scale and workers** | T21 to T23 | Redis adapter and 2 instances, worker jobs, graceful shutdown | `v0.5.0` |
| **Phase 5 - Frontend** | T24 to T30 | complete web client | `v0.9.0` |
| **Phase 6 - Quality and release** | T31 to T33 | full tests, load test, README, release | `v1.0.0` |

| ID | Task | Branch | Size |
| --- | --- | --- | --- |
| T00 | Repository bootstrap and tooling | `chore/t00-repo-bootstrap` | M |
| T01 | Dev infra, env validation, app skeleton, `/health` | `feat/t01-app-skeleton` | M |
| T02 | Contracts package, error model, validation middleware | `feat/t02-contracts-base` | M |
| T03 | Database schema, migration, seed, `/ready` | `feat/t03-database` | L |
| T04 | Continuous integration | `ci/t04-github-actions` | S |
| T05 | Register | `feat/t05-auth-register` | M |
| T06 | Login and auth middleware | `feat/t06-auth-login` | M |
| T07 | Refresh rotation and logout | `feat/t07-auth-refresh-logout` | L |
| T08 | Auth rate limiting and lockout | `feat/t08-auth-rate-limit` | S |
| T09 | Profile and user search | `feat/t09-users` | M |
| T10 | Direct conversations | `feat/t10-direct-conversations` | M |
| T11 | Group conversations and members | `feat/t11-group-conversations` | L |
| T12 | Chat list | `feat/t12-chat-list` | M |
| T13 | Message history | `feat/t13-message-history` | M |
| T14 | Socket server and handshake auth | `feat/t14-socket-auth` | M |
| T15 | Send message (transaction, idempotency, broadcast) | `feat/t15-send-message` | L |
| T16 | Delivered and read status, unread counts | `feat/t16-status-unread` | L |
| T17 | Delete message | `feat/t17-delete-message` | S |
| T18 | Typing indicator | `feat/t18-typing` | S |
| T19 | Presence | `feat/t19-presence` | L |
| T20 | Reconnect and gap fill (server side and CLI proof) | `feat/t20-gap-fill` | M |
| T21 | Redis adapter, 2 instances, nginx, full Compose | `feat/t21-scale-out` | L |
| T22 | Worker app and jobs | `feat/t22-workers` | L |
| T23 | Graceful shutdown, metrics, logging polish | `feat/t23-shutdown-observability` | M |
| T24 | Web app setup, API client, auth pages | `feat/t24-web-auth` | L |
| T25 | Chat list and new-chat flow | `feat/t25-web-chat-list` | M |
| T26 | Conversation pane and history | `feat/t26-web-conversation` | L |
| T27 | Realtime send, optimistic UI, outbox | `feat/t27-web-realtime-send` | L |
| T28 | Status ticks, typing, presence, unread UI | `feat/t28-web-live-state` | M |
| T29 | Reconnect UX and gap fill in the client | `feat/t29-web-reconnect` | M |
| T30 | Group chat UI | `feat/t30-web-groups` | M |
| T31 | Test completion and edge cases | `test/t31-coverage-edge-cases` | M |
| T32 | Load test and results | `feat/t32-load-test` | M |
| T33 | README, docs, release | `docs/t33-readme-release` | M |

Size guide: S about 2 to 4 hours, M about half a day to 1 day, L about 1 to 2 days.

## 6. Phase 0 - Foundation

### T00 - Repository bootstrap and tooling

**Branch:** `chore/t00-repo-bootstrap` (committed directly to `main`) | **Depends on:** nothing

**Goal:** an empty but fully wired monorepo where lint, typecheck and tests run.

**Checklist**

- [ ] `git init`, create GitHub repo, set branch protection and labels (section 3.1)
- [ ] Files: `.gitignore` (node\_modules, dist, .env, coverage), `.editorconfig`, `.nvmrc` (22), `LICENSE` (MIT), minimal `README.md`
- [ ] `pnpm-workspace.yaml` listing `apps/*` and `packages/*`
- [ ] Create empty packages with their own `package.json` and `tsconfig.json`: `apps/api`, `apps/worker`, `apps/web` (placeholder), `packages/contracts`
- [ ] `tsconfig.base.json` with `strict: true`, `noUncheckedIndexedAccess: true`, ES2022, `moduleResolution: bundler` or `nodenext`
- [ ] ESLint (flat config, typescript-eslint) and Prettier (shared config at root)
- [ ] `husky` with `pre-commit` (lint-staged: eslint + prettier on staged files) and `commit-msg` (commitlint with conventional preset)
- [ ] Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `format`
- [ ] Vitest installed at root with a workspace config; one trivial passing test per package

**Done when:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` all pass, and a commit with a bad message is rejected by commitlint.

**Commit:** `chore: bootstrap monorepo tooling`

### T01 - Dev infra, env validation, app skeleton, `/health`

**Branch:** `feat/t01-app-skeleton` | **Depends on:** T00

**Goal:** the API starts, reads validated config, logs in JSON, and answers `GET /health`.

**Checklist**

- [ ] `docker-compose.dev.yml` with `postgres:16` and `redis:7`, named volumes, healthchecks (decision D5). An init script creates a second database `chat_test`.
- [ ] `.env.example` with `NODE_ENV`, `PORT`, `DATABASE_URL`, `DATABASE_URL_TEST`, `REDIS_URL`, `LOG_LEVEL` (Project Doc 15.1). Add `.env` to `.gitignore`.
- [ ] `apps/api/src/config/env.ts`: Zod schema, parse `process.env` once, exit with a clear message when invalid
- [ ] `apps/api/src/infra/logger.ts`: pino, pretty in development, JSON otherwise
- [ ] `apps/api/src/http/app.ts`: `createApp()` factory (no `listen`, so tests can import it)
- [ ] Middleware: request id (header `x-request-id`, generated if missing), request logging, JSON body limit (100 kb), `helmet`, CORS from env allowlist
- [ ] Error handling: `AppError` class (`code`, `status`, `message`, `details`) with subclasses `ValidationError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitedError`; one central error middleware that returns the envelope from Project Doc 7.1; a 404 handler
- [ ] `GET /health` returns `200 { "status": "ok", "uptime": <seconds> }`
- [ ] `apps/api/src/main.ts`: create the app, `listen` on `PORT`, log the startup line

**Tests:** Supertest on `/health` (200), unknown route returns the 404 envelope, a route that throws returns the 500 envelope without a stack trace.

**Done when:** `docker compose -f docker-compose.dev.yml up -d` then `pnpm --filter api dev` serves `/health`; a missing env var stops startup with a readable error.

**Commit / PR title:** `feat(infra): add app skeleton, env validation and health endpoint`

### T02 - Contracts package, error model, validation middleware

**Branch:** `feat/t02-contracts-base` | **Depends on:** T01

**Goal:** shared types and one consistent way to validate input.

**Checklist**

- [ ] `packages/contracts` built with `tsup` (ESM + types), consumed by `apps/api` through the workspace (decision D10)
- [ ] `errors.ts`: `ErrorCode` enum (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`) and `ErrorEnvelope` Zod schema
- [ ] `common.ts`: `IdSchema` (string), `PaginationQuery` (`limit` default 30, max 100), ISO date helper
- [ ] `apps/api/src/http/middleware/validate.ts`: `validate({ body?, query?, params? })` that parses with Zod, replaces the request values with parsed output, and throws `ValidationError` with `details` listing `{ path, message }` per issue
- [ ] Make the error middleware use the shared `ErrorCode` enum

**Tests:** schema unit tests; a throwaway route in the test file verifies that invalid body returns `400 VALIDATION_ERROR` with field details and valid body passes through typed.

**Done when:** the API imports a type from `@chat/contracts` and builds; validation errors look exactly like the contract.

**Commit / PR title:** `feat(contracts): add shared error model and validation middleware`

### T03 - Database schema, migration, seed, `/ready`

**Branch:** `feat/t03-database` | **Depends on:** T02

**Goal:** the full MVP schema exists in PostgreSQL, with sample data and a readiness probe.

**Checklist**

- [ ] Add Prisma; create `prisma/schema.prisma` with the MVP models from Project Doc 6.2 (`User`, `Session`, `Conversation`, `Participant`, `Message`)
- [ ] First migration: `pnpm prisma migrate dev --name init`; commit the `migrations/` folder
- [ ] `apps/api/src/infra/prisma.ts` (singleton) and `apps/api/src/infra/redis.ts` (ioredis singleton, `maxRetriesPerRequest: null`)
- [ ] `prisma/seed.ts`: 5 users (`alice`, `bob`, `carol`, `dave`, `erin`, all with password `Password123!` hashed with argon2), 1 direct chat (alice-bob) with 20 messages, 1 group (alice, bob, carol) with 10 messages. Seed must create **correct `seq`, `lastSeq`, `lastMessageId`, `directKey`** values.
- [ ] Scripts: `db:migrate`, `db:deploy`, `db:seed`, `db:reset`
- [ ] Test helper `test/helpers/db.ts`: connects to `DATABASE_URL_TEST`, runs migrations once in Vitest `globalSetup`, exposes `resetDb()` (truncate all tables, restart identity)
- [ ] `GET /ready`: pings Postgres (`SELECT 1`) and Redis (`PING`); `200 { status: "ready" }` or `503 { status: "not_ready", checks: { postgres, redis } }`

**Tests:** unique constraints (`directKey`, `(senderId, clientMessageId)`, `(conversationId, seq)`) are enforced; `/ready` returns 200 normally and 503 when Redis is stopped (use a client pointed at a closed port).

**Done when:** `pnpm db:reset` gives a populated database that you can open with `prisma studio`; `/ready` is green.

**Commit / PR title:** `feat(db): add prisma schema, migration, seed and readiness probe`

### T04 - Continuous integration

**Branch:** `ci/t04-github-actions` | **Depends on:** T03

**Checklist**

- [ ] `.github/workflows/ci.yml` triggered on `pull_request` and on push to `main`
- [ ] Services: `postgres:16` and `redis:7` with health checks; env vars for test URLs
- [ ] Steps: checkout, pnpm setup with cache, Node 22, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm prisma migrate deploy`, `pnpm test`
- [ ] Add the PR and issue templates from sections 3.5 and 3.6
- [ ] Mark the `ci` job as a **required check** in branch protection
- [ ] Add a CI badge to the README
- [ ] Create GitHub issues T05 to T33 now if you have not already

**Done when:** a test PR shows the CI check running and passing; merging is blocked when it fails.

**Commit / PR title:** `ci: add GitHub Actions pipeline and repo templates`

**Phase 0 finished: tag `v0.1.0`.**

## 7. Phase 1 - Authentication

Goal of the phase: users can safely create accounts and keep sessions alive. Design details are in Project Doc 7.2.

### T05 - Register

**Branch:** `feat/t05-auth-register` | **Depends on:** T04

**Goal:** `POST /api/v1/auth/register` creates a user and returns the first session.

**Decisions:** use `jose` for JWT, `argon2` (argon2id) for hashing, `cookie-parser` for cookies. The token and session helpers are built here because T06 and T07 reuse them.

**Checklist**

- [ ] Env additions (validated in `env.ts` and added to `.env.example`): `JWT_ACCESS_SECRET` (min 32 chars), `JWT_ACCESS_TTL_SECONDS=900`, `REFRESH_TTL_DAYS=30`, `COOKIE_SECURE` (`false` in dev)
- [ ] Contracts: `RegisterBody` (`email` valid and lowercased, `username` 3-20 chars `[a-z0-9_]` lowercased, `password` 8-72 chars, `displayName` 1-50 trimmed), `UserDto` (`id, username, displayName, avatarUrl, createdAt`), `MeDto` (UserDto + `email`), `AuthResponse` (`{ user: MeDto, accessToken }`)
- [ ] `modules/auth/tokens.ts`: `signAccessToken({ userId, sessionId })` (claims `sub`, `sid`, `iat`, `exp`), `generateRefreshToken()` (32 random bytes, base64url), `hashRefreshToken()` (sha256 hex)
- [ ] `modules/auth/sessions.ts`: `createSession({ userId, familyId?, userAgent, ip })` stores only the hash, returns the raw token once
- [ ] `modules/auth/cookies.ts`: `setRefreshCookie(res, token)` and `clearRefreshCookie(res)` with `httpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`, `Secure` from env, `Max-Age` from `REFRESH_TTL_DAYS`
- [ ] `modules/auth/auth.service.ts` `register()`: check email and username uniqueness (return `409 CONFLICT` with `details: { field }`), hash the password, create the user, create the session
- [ ] Route `POST /auth/register` returns `201 { user, accessToken }` plus the cookie; mount all routers under `/api/v1`
- [ ] `requests/auth.http` with a register example

**Tests:** success response shape; password is stored hashed (never equals plaintext); duplicate email and duplicate username return 409 (case-insensitive); invalid fields return 400 with details; refresh cookie has the right flags; the stored session holds a hash, not the raw token.

**Done when:** registering from the `.http` file returns a token and a `Set-Cookie` header.

**PR title:** `feat(auth): add user registration with session issuing`

### T06 - Login and auth middleware

**Branch:** `feat/t06-auth-login` | **Depends on:** T05

**Checklist**

- [ ] Contract `LoginBody` (`email`, `password`)
- [ ] `login()`: find user by lowercased email; verify with argon2; wrong email and wrong password both return the **same** `401 UNAUTHENTICATED` ("Invalid email or password"). When the user does not exist, still run a verify against a dummy hash to keep response time similar.
- [ ] Route `POST /auth/login` returns `200 { user, accessToken }` plus cookie (store `userAgent` and `ip` on the session)
- [ ] `http/middleware/requireAuth.ts`: reads `Authorization: Bearer`, verifies signature and expiry, sets `req.auth = { userId, sessionId }`. Expired token returns `401 TOKEN_EXPIRED`; anything else invalid returns `401 UNAUTHENTICATED`.
- [ ] **Decision:** revoked sessions are detected through a Redis key `revoked:sid:{sessionId}` (written on logout in T07, TTL equal to the access token lifetime) so the middleware does not hit PostgreSQL on every request. The middleware checks that key now.
- [ ] Extend the Express `Request` type with `auth`
- [ ] `GET /users/me` returns `MeDto` (this gives you a protected route to prove the middleware; T09 adds the rest of the users module)

**Tests:** login success; wrong password and unknown email give identical responses; protected route without token is 401; expired token (sign one with a past `exp`) gives `TOKEN_EXPIRED`; token with a tampered signature is rejected; a revoked `sid` key blocks the request.

**Done when:** register, then login, then `GET /users/me` with the bearer token works from the `.http` file.

**PR title:** `feat(auth): add login and bearer auth middleware`

### T07 - Refresh rotation and logout

**Branch:** `feat/t07-auth-refresh-logout` | **Depends on:** T06

**Checklist**

- [ ] `POST /auth/refresh` (no body, reads the cookie): hash the cookie value and look up the session
  - not found, or expired: `401 UNAUTHENTICATED` and clear the cookie
  - found and **already revoked**: reuse detected, revoke every session with the same `familyId`, clear the cookie, `401`
  - valid: in one transaction revoke the old session and create a new one with the **same `familyId`**; return `{ accessToken }` and a new cookie
- [ ] **Decision (multi-tab race):** if a revoked token is presented within **10 seconds** of its rotation, return `401` without revoking the family (two tabs refreshed at once); after 10 seconds treat it as theft and revoke the family
- [ ] `POST /auth/logout`: revoke the current session (from the cookie), set Redis key `revoked:sid:{sessionId}` with `EX = JWT_ACCESS_TTL_SECONDS`, clear the cookie, return `204`. Calling it again or without a cookie also returns `204` (idempotent).
- [ ] Add refresh and logout examples to `requests/auth.http`

**Tests:** a rotated token is single use; reuse after the grace window revokes the whole family (the newest token stops working too); expired session is rejected; after logout the old access token is rejected immediately by `requireAuth`; logout is idempotent; a stolen-then-used token scenario end to end.

**Done when:** you can log in, refresh twice, log out, and each old token fails as described.

**PR title:** `feat(auth): add refresh token rotation with reuse detection and logout`

### T08 - Auth rate limiting and lockout

**Branch:** `feat/t08-auth-rate-limit` | **Depends on:** T07

**Checklist**

- [ ] `infra/rateLimit.ts`: `rateLimit({ key, limit, windowSeconds })` using Redis `INCR` plus `EXPIRE` (fixed window). **Decision:** fixed window is enough for the MVP; this same helper is reused by sockets in T15.
- [ ] Express middleware `limitByIp(name, limit, windowSeconds)` returning `429 RATE_LIMITED` with a `Retry-After` header
- [ ] Apply: register and login `10/min` per IP; general API `100/min` per IP
- [ ] Account lockout: increment `login:fail:{email}` on each failed login (TTL 15 min); at 5 failures return `429` until the key expires; delete the key on successful login
- [ ] `TRUST_PROXY` env (number of proxies) passed to `app.set('trust proxy', ...)` so the real client IP is used behind nginx
- [ ] Make limits configurable through the app factory options so tests can use small windows

**Tests:** the 11th login attempt in a window is limited; limits are per IP; five bad passwords lock the account even with a correct sixth; successful login resets the counter; `Retry-After` is present.

**Done when:** hammering `/auth/login` from the `.http` file returns 429.

**PR title:** `feat(auth): add redis rate limiting and login lockout`

**Phase 1 finished: tag `v0.2.0`.**

## 8. Phase 2 - REST Core

Goal of the phase: everything except live messaging works over REST. Contracts: Project Doc 7.3 to 7.5.

### T09 - Profile and user search

**Branch:** `feat/t09-users` | **Depends on:** T08

**Checklist**

- [ ] `PATCH /users/me` with `{ displayName?, avatarUrl? }` (at least one field; `avatarUrl` must be an `https` URL up to 500 chars or `null`). **Decision:** no file upload in the MVP, avatars are URLs.
- [ ] `GET /users?q=&limit=`: `q` at least 2 chars, case-insensitive match on `username` or `displayName` (Prisma `contains` with `mode: 'insensitive'`), excludes the caller, `limit` default 10 and max 20, ordered by username. **Decision:** plain `ILIKE`; add a `pg_trgm` index only if it becomes slow.
- [ ] `GET /users/:id` returns the public `UserDto`; unknown id is `404`
- [ ] Contracts: `UpdateProfileBody`, `UserSearchQuery`; `requests/users.http`

**Tests:** update persists and validates; search excludes self and is case-insensitive; short `q` returns 400; limit cap; all routes require auth.

**PR title:** `feat(users): add profile update, user search and public profile`

### T10 - Direct conversations

**Branch:** `feat/t10-direct-conversations` | **Depends on:** T09

**Checklist**

- [ ] Contracts: `CreateConversationBody` as a discriminated union on `type` (`DIRECT { userId }` and, for T11, `GROUP`), `ConversationDto` (Project Doc 7.7)
- [ ] `modules/conversations/mappers.ts`: `toConversationDto(row, viewerId)`; `peerPresence` stays `null` until T19
- [ ] `POST /conversations` with `DIRECT`: reject self (`400`), unknown user (`404`), compute `directKey = [a, b].sort().join(':')`, find or create inside a transaction with two `Participant` rows (both `lastDeliveredSeq` and `lastReadSeq` 0). Return `201` when created and `200` when it already existed.
- [ ] Handle the race: when the unique `directKey` insert fails (Prisma `P2002`), re-read and return the existing conversation
- [ ] On creation set `lastMessageAt = now()` (the chat list in T12 sorts on it and must never see nulls)
- [ ] `GET /conversations/:id`: members only; non-members get `404`
- [ ] `requests/conversations.http`

**Tests:** opening A-B and B-A yields the same conversation; 20 concurrent creates produce exactly one row; self chat rejected; non-member `GET` is 404.

**PR title:** `feat(conversations): add direct conversation creation and retrieval`

### T11 - Group conversations and members

**Branch:** `feat/t11-group-conversations` | **Depends on:** T10

**Checklist**

- [ ] **Decision:** the `RealtimeGateway` interface is defined now in `realtime/gateway.ts` (`toUser`, `toConversation`, `joinUserToConversation`, `removeUserFromConversation`) with a `NoopGateway` default injected into the services. T14 provides the Socket.IO implementation, so REST code never imports Socket.IO.
- [ ] `modules/messages/seq.ts`: `allocateSeq(tx, conversationId)` (the atomic increment from Project Doc 6.4) and `createSystemMessage(tx, conversationId, text, metadata)`. T15 reuses `allocateSeq`.
- [ ] `POST /conversations` with `GROUP { name 1-100, memberIds[] }`: dedupe, remove self, between 1 and 255 other members, all must exist; creator becomes `OWNER`; insert a `SYSTEM` message ("Alice created the group"); set `joinedAtSeq` for members to 0 for the initial members
- [ ] `PATCH /conversations/:id` `{ name }`: admin or owner; system message "Alice renamed the group"
- [ ] `POST /conversations/:id/members` `{ userIds[] }`: admin or owner; skip people already active; re-adding someone who left clears `leftAt`; new members get `joinedAtSeq = lastSeq` so they cannot read earlier history; max group size 256 (`409`)
- [ ] `DELETE /conversations/:id/members/:userId`: admin or owner removes members; **only the owner can remove an admin**; the owner cannot be removed; a user may remove themselves
- [ ] `POST /conversations/:id/leave`: sets `leftAt`; if the owner leaves, ownership moves to the oldest admin, otherwise the oldest member
- [ ] All group endpoints return `400` for a `DIRECT` conversation; call the gateway after commit (no-op for now)
- [ ] **Decision:** no role editing endpoint in the MVP (roles change only through ownership transfer)

**Tests:** permission matrix (owner, admin, member, outsider) for every endpoint; `seq` increments for each system message with no gaps; size cap; ownership transfer; re-added member cannot see old messages (verified in T13).

**PR title:** `feat(conversations): add group chats, member management and system messages`

### T12 - Chat list

**Branch:** `feat/t12-chat-list` | **Depends on:** T11

**Checklist**

- [ ] `GET /conversations?limit=&cursor=`: only conversations where the caller has `leftAt = null`, ordered by `lastMessageAt DESC, id DESC`; `limit` default 30, max 50
- [ ] Cursor is an opaque base64 of `{ lastMessageAt, id }`; response `{ items, nextCursor }`
- [ ] Each item: `lastMessage` (content is `null` when deleted), `unreadCount`, `myLastReadSeq`, `lastSeq`; for `DIRECT` the single peer, for `GROUP` the first 5 members plus `memberCount` (add `memberCount` to `ConversationDto`)
- [ ] **No N+1 queries:** at most 3 database queries per request (participations with conversation, last messages, members)
- [ ] Add the `Participant(userId, leftAt)` and `Conversation(lastMessageAt)` indexes if missing

**Tests:** ordering after new messages (use seeded data); pagination with identical timestamps returns no duplicates or skips; left conversations are hidden; unread counts match the seed; query count assertion.

**PR title:** `feat(conversations): add paginated chat list with unread counts`

### T13 - Message history

**Branch:** `feat/t13-message-history` | **Depends on:** T12

**Checklist**

- [ ] Contract `MessageHistoryQuery`: `beforeSeq?`, `afterSeq?`, `limit` (default 30, max 100); sending both cursors is `400`
- [ ] `GET /conversations/:id/messages`
  - no cursor: latest messages, newest first
  - `beforeSeq`: older messages, newest first
  - `afterSeq`: newer messages, **oldest first** (used for gap fill)
  - response `{ items, hasMore }`; fetch `limit + 1` rows to compute `hasMore`
- [ ] Always filter `seq > participant.joinedAtSeq`; non-members and users who left get `404`
- [ ] `toMessageDto`: deleted messages return `content: null` and `deletedAt`; `replyTo` is `{ id, senderId, preview }` where `preview` is the first 80 characters of the replied message (or `null` if that message is deleted)
- [ ] `requests/messages.http`

**Tests:** walking pages with `beforeSeq` yields every message once; `afterSeq` ascending order; limit cap; `joinedAtSeq` hides old messages from a late joiner; deleted content hidden; non-member 404.

**PR title:** `feat(messages): add cursor paginated message history`

**Phase 2 finished: tag `v0.3.0`.** At this point the whole REST contract exists and is tested.

## 9. Phase 3 - Realtime

Goal of the phase: live messaging with correct delivery semantics. Contracts: Project Doc 8 and 9. Every task here is verified with automated tests using real `socket.io-client` connections, plus the socket CLI.

### T14 - Socket server and handshake auth

**Branch:** `feat/t14-socket-auth` | **Depends on:** T13

**Checklist**

- [ ] Add `socket.io`; `realtime/server.ts` exports `createRealtimeServer(httpServer, deps)`; `main.ts` attaches it to the same HTTP server
- [ ] Options: `pingInterval: 25000`, `pingTimeout: 20000`, `maxHttpBufferSize: 100_000`, CORS from env
- [ ] Move the event interfaces `ClientToServerEvents` and `ServerToClientEvents` (Project Doc 8.5) into `packages/contracts/src/socket.ts` and use them as generics for the typed `Server`
- [ ] `realtime/auth.ts`: io middleware reads `socket.handshake.auth.token`, verifies it with the same function as `requireAuth`, checks `revoked:sid:*`, stores `socket.data = { userId, sessionId, tokenExp }`; failures call `next(new Error('TOKEN_EXPIRED' | 'UNAUTHENTICATED'))`
- [ ] On `connection`: join `user:{userId}`; load the user's active conversation ids and join `conv:{id}` for each; emit `ready { serverTime }`
- [ ] **Decision:** schedule `socket.disconnect(true)` at the token expiry time; the client refreshes the token and reconnects (this keeps revoked or expired sessions from staying connected for days)
- [ ] `realtime/handler.ts`: helper `handle(socket, event, zodSchema, fn)` that validates the payload, runs `fn`, converts thrown `AppError` to `{ ok: false, error }` acks, logs unexpected errors and returns `INTERNAL`. **All later socket handlers must use it.**
- [ ] `realtime/socketGateway.ts`: the real `RealtimeGateway` (from T11) using `io.to(...).emit` and `io.in(...).socketsJoin/socketsLeave`; replace `NoopGateway` in `main.ts` and call it from the group services (events `conversation:created`, `conversation:updated`, `conversation:removed`)
- [ ] `scripts/socket-cli.ts`: logs in through REST, connects, prints every event, supports commands typed on stdin (extended in later tasks); document in `docs/dev.md`

**Tests:** valid token connects and receives `ready`; missing, garbage, expired and revoked tokens are refused with the right message; socket is in the correct rooms (use `io.in(room).fetchSockets()`); creating a group makes the member's live socket join the new room and emit `conversation:created`; removed member leaves the room and gets `conversation:removed`.

**PR title:** `feat(realtime): add socket server with handshake auth, rooms and gateway`

### T15 - Send message

**Branch:** `feat/t15-send-message` | **Depends on:** T14

**Checklist**

- [ ] Contracts: `SendMessageInput`, `SendMessageAck` (Project Doc 8.3, 8.5)
- [ ] `messages/messages.service.ts` `sendMessage()` implementing the transaction in Project Doc 6.4 using `allocateSeq`: idempotency lookup, membership check, seq, insert, conversation pointers, unread counters, sender watermarks
- [ ] If `replyToId` is given it must belong to the **same conversation** (`400` otherwise)
- [ ] Handle the idempotency race: catch the unique violation on `(senderId, clientMessageId)`, re-read, return `duplicate: true`
- [ ] Handler `message:send` via `handle()`: rate limit with the T08 helper (`rl:sock:{userId}:message:send`, 20 per 10 s; on limit ack `RATE_LIMITED` and emit `rate_limited`), validate, call the service
- [ ] **Decision:** broadcast `message:new` to `conv:{id}` **after the transaction commits**, never inside it, and only when `duplicate` is false. If the process dies between commit and emit, clients recover through gap fill (T20).
- [ ] The sender's own sockets also receive `message:new` (other devices stay in sync); clients dedupe by message id
- [ ] Content: trimmed, 1 to 4000 chars, whitespace-only rejected
- [ ] CLI command `send <conversationId> <text>`

**Tests:** ack contains the stored message with `seq`; the other member receives `message:new` exactly once; sending the same `clientMessageId` twice returns the same message and the recipient gets no second event; non-member gets `FORBIDDEN`; 50 concurrent sends from two users produce `seq` 1..50 contiguous with no duplicates; invalid payload gets `VALIDATION_ERROR`; rate limit triggers; unread counts of other members increase and the sender's stay 0; reply across conversations is rejected.

**PR title:** `feat(messages): add idempotent realtime message sending with ordered seq`

### T16 - Delivered and read status, unread counts

**Branch:** `feat/t16-status-unread` | **Depends on:** T15

**Checklist**

- [ ] Handler `message:delivered { conversationId, upToSeq }`: reject `upToSeq > conversation.lastSeq`; set `lastDeliveredSeq = GREATEST(current, upToSeq)` (single SQL update so it can only move forward); if it advanced, emit `message:status { kind: 'delivered' }` to the room; ack
- [ ] Handler `conversation:read { conversationId, upToSeq }`: same monotonic update for `lastReadSeq` (also raise `lastDeliveredSeq` to at least that value); **recompute** `unreadCount` as the number of messages with `seq > upToSeq`, `senderId != me`, `deletedAt IS NULL` (**decision:** recomputing is self-healing, the query is cheap with the `(conversationId, seq)` index); emit `message:status { kind: 'read' }`; ack `{ unreadCount }`
- [ ] REST fallback `POST /conversations/:id/read { upToSeq }` returns `204` and shares the same service
- [ ] Add `receipts: { deliveredUpTo, readUpTo }` to `ConversationDto`: for `DIRECT` the peer's watermarks, for `GROUP` the **minimum** across the other active members. Update the mapper and the chat list so the client can draw ticks right after loading.
- [ ] Shared helper `deriveStatus(seq, receipts)` returning `sent | delivered | read` in `packages/contracts`
- [ ] CLI commands `delivered` and `read`

**Tests:** watermarks never move backwards; `upToSeq` beyond `lastSeq` rejected; status events broadcast only when something changed; unread count is correct after partial reads; group minimum computed correctly; non-members forbidden; `deriveStatus` unit tests.

**PR title:** `feat(messages): add delivery and read watermarks with unread recount`

### T17 - Delete message

**Branch:** `feat/t17-delete-message` | **Depends on:** T16

**Checklist**

- [ ] Handler `message:delete { messageId }` and REST `DELETE /messages/:id` share one service; only the sender may delete; `SYSTEM` messages cannot be deleted (`400`)
- [ ] Set `deletedAt`; the row keeps its `seq`. **Decision:** content stays in the database but is never returned (purging is a post-MVP job). Operation is idempotent.
- [ ] Decrement `unreadCount` (not below 0) for participants whose `lastReadSeq < message.seq`, excluding the sender, in one `updateMany`
- [ ] Emit `message:deleted { conversationId, messageId, seq }` to the room
- [ ] `conversation.lastMessage` keeps pointing at the deleted message; the DTO shows `content: null` (**decision:** the UI renders "This message was deleted")

**Tests:** only the sender can delete; second delete is a no-op; event broadcast once; history and chat list return `content: null`; unread count adjusts; deleting a system message fails.

**PR title:** `feat(messages): add delete message for everyone`

### T18 - Typing indicator

**Branch:** `feat/t18-typing` | **Depends on:** T17

**Checklist**

- [ ] Handlers `typing:start` and `typing:stop`: membership is checked with `socket.rooms.has('conv:' + id)` (**decision:** no DB hit for a high-frequency event)
- [ ] Broadcast `typing { conversationId, userId, isTyping }` with `socket.to(room)` (everyone except the sender); nothing is stored
- [ ] Rate limit `typing:*` to 10 per 10 s per user, silently dropping extra events
- [ ] After a successful `message:send`, the server emits `typing { isTyping: false }` for that user (the indicator clears the moment the message appears)
- [ ] CLI commands `typing on|off`

**Tests:** other member receives the event, sender does not; non-member events are ignored; dropped events when rate limited; `isTyping: false` follows a sent message.

**PR title:** `feat(realtime): add typing indicators`

### T19 - Presence

**Branch:** `feat/t19-presence` | **Depends on:** T18

**Checklist**

- [ ] `modules/presence/presence.service.ts` using the Redis design in Project Doc 10: `connect(userId, socketId)`, `heartbeat(userId, socketId)`, `disconnect(userId, socketId)`, `getPresence(userIds[])` (pipelined, returns `{ online, lastSeenAt }`)
- [ ] On connect: ZADD with a 60 s expiry score; if this is the first live socket, add the user to `presence:active` and broadcast `presence:update { online: true }` to the user's `conv:*` rooms
- [ ] Handler `presence:ping`: refresh the score (clients ping every 25 s)
- [ ] On disconnect: ZREM; if no live sockets remain, wait **5 seconds** (**decision:** debounce against reconnect flapping, recheck in Redis so it also works when the user returns on another instance), then write `lastSeen:{userId}`, add to `lastSeen:dirty`, remove from `presence:active`, broadcast `presence:update { online: false, lastSeenAt }`
- [ ] Fill `peerPresence` in `ConversationDto` for direct chats (detail and list), falling back to `User.lastSeenAt` when Redis has no value
- [ ] `GET /presence?ids=a,b,c` (max 50 ids) returns `{ items: [{ userId, online, lastSeenAt }] }`; **decision:** presence is public to anyone who can start a chat with the user in the MVP (no privacy settings)
- [ ] CLI prints presence events

**Tests:** two sockets for one user produce a single online transition; closing one keeps the user online; closing both produces one offline event after the debounce with `lastSeenAt`; an expired heartbeat score counts as offline; `peerPresence` and `/presence` are correct; reconnecting inside the debounce window emits no offline event.

**PR title:** `feat(presence): add redis based presence with last seen`

### T20 - Reconnect, gap fill and the shared client core

**Branch:** `feat/t20-gap-fill` | **Depends on:** T19

**Goal:** prove the reliability story and write the client logic **once**, framework-free, so both the CLI and the web app use it.

**Decision:** create `packages/client-core` (TypeScript, no React) containing the realtime client logic. The web tasks (T27 to T29) only bind it to UI state.

**Checklist**

- [ ] `ChatClient` class: constructor takes `{ baseUrl, getAccessToken, refreshAccessToken, storage }`; connects with `transports: ['websocket']`, auto reconnection with backoff; on `connect_error` `TOKEN_EXPIRED` it refreshes and reconnects
- [ ] **Outbox:** `send(conversationId, content, replyToId?)` creates a `clientMessageId`, stores the pending message, emits with a 5 s ack timeout, retries with backoff (500 ms, doubling, max 5 attempts), then marks `failed`; `retry(clientMessageId)` for manual retry; the pending list is flushed after every reconnect
- [ ] **Gap detection:** pure functions `detectGap(localLastSeq, incomingSeq)` and `mergeMessages(existing, incoming)` (dedupe by id, sort by `seq`)
- [ ] `syncAll()`: calls `GET /conversations`, compares `lastSeq` with the stored value for each, and fetches `afterSeq` pages until `hasMore` is false; runs after every reconnect and when a live `message:new` skips a seq
- [ ] Auto `message:delivered` after receiving messages and `presence:ping` every 25 s
- [ ] Storage adapter interface (`getLastSeq`, `setLastSeq`, outbox persistence) with an in-memory default
- [ ] Rewrite the CLI to use `ChatClient`

**Tests (integration, real server):** disconnect a client, send 20 messages from another user, reconnect, `syncAll()` yields exactly those 20 in order; lost-ack scenario (drop the first ack) resends with the same `clientMessageId` and the server stores one message; a skipped live seq triggers the gap fetch; outbox flushes in order after reconnect; token expiry during a session reconnects transparently.

**PR title:** `feat(client): add client-core with outbox, reconnect and gap fill`

**Phase 3 finished: tag `v0.4.0`.** The backend is functionally complete.

## 10. Phase 4 - Scale and Workers

### T21 - Redis adapter, 2 instances, nginx, full Compose

**Branch:** `feat/t21-scale-out` | **Depends on:** T20

**Checklist**

- [ ] Add `@socket.io/redis-adapter` with a dedicated pub client and sub client (duplicates of the ioredis connection); attach in `createRealtimeServer`
- [ ] `INSTANCE_ID` env (hostname by default) added to every log line and to `/health`
- [ ] `apps/api/Dockerfile`: multi-stage build (install with pnpm, build contracts and api, run as non-root user, `node dist/main.js`)
- [ ] `docker-compose.yml` (production-like): `postgres`, `redis`, `migrate` (one-shot `prisma migrate deploy`), `api1`, `api2`, `nginx`; env from `.env`; the worker and web services are added in T22 and T24 (Project Doc 15.2)
- [ ] `infra/nginx.conf`: upstream with both APIs, `location /api/` and `location /socket.io/` with `proxy_http_version 1.1`, `Upgrade` and `Connection` headers, `proxy_read_timeout 3600s`, forwarded IP headers; set `TRUST_PROXY=1`
- [ ] **Decision:** clients use `transports: ['websocket']` only, so sticky sessions are unnecessary. (If polling is ever enabled, add `ip_hash` or sticky cookies.)
- [ ] `docs/scaling.md` explaining the message path across instances

**Tests:** an integration test starts **two** API servers in one process on different ports sharing Redis and Postgres: client A on server 1 and client B on server 2 exchange messages, typing and status events; a user added to a group while connected to the other instance joins the room (`socketsJoin` across instances); presence is consistent across instances. Manual: `docker compose up --build`, connect two CLI sessions through nginx (they may land on different instances, see `INSTANCE_ID` in logs).

**PR title:** `feat(infra): add redis adapter, multi-instance compose and nginx`

### T22 - Worker app and jobs

**Branch:** `feat/t22-workers` | **Depends on:** T21

**Checklist**

- [ ] `apps/worker`: BullMQ with the shared Redis; each job lives in `jobs/<name>.ts` exporting a plain `run(deps)` function (testable without BullMQ) plus a thin registration file; repeatable schedules are registered at startup; retries 3 with exponential backoff
- [ ] `last-seen-flush` (every 30 s): pop up to 500 ids at a time from `lastSeen:dirty`, read `lastSeen:{id}`, write all with one bulk `UPDATE ... FROM (VALUES ...)`, loop until empty
- [ ] `session-cleanup` (hourly): delete sessions expired or revoked more than 7 days ago, in batches
- [ ] `unread-reconcile` (nightly): recompute `unreadCount` for participants in batches and log how many rows were corrected
- [ ] `presence-sweep` (every 30 s): for users in `presence:active` with no live sockets, remove them, set last seen and emit `presence:update { online: false }` through `@socket.io/redis-emitter` to the user's conversation rooms (look up conversation ids in the database)
- [ ] Structured logging, graceful shutdown (`worker.close()`), `apps/worker/Dockerfile`, add the `worker` service to Compose

**Tests:** each `run()` against real Postgres and Redis (seed state, run, assert); the sweeper emits an offline event that a connected socket client receives; jobs are idempotent (run twice, same result).

**PR title:** `feat(worker): add bullmq worker with last-seen, cleanup, reconcile and presence jobs`

### T23 - Graceful shutdown and observability

**Branch:** `feat/t23-shutdown-observability` | **Depends on:** T22

**Checklist**

- [ ] Shutdown handler on `SIGTERM` and `SIGINT`: set a `shuttingDown` flag so `/ready` returns `503`, stop accepting connections, `io.close()` (clients reconnect to another instance), wait for in-flight work, close Redis and Prisma, exit `0`; hard timeout 15 s then exit `1`
- [ ] Log `unhandledRejection` and `uncaughtException`, then shut down
- [ ] `prom-client` metrics on `GET /metrics`: gauge `sockets_connected`, counters `messages_sent_total`, `socket_ack_errors_total`, `rate_limited_total`, histograms `message_send_duration_seconds` and `http_request_duration_seconds`. **Decision:** `/metrics` is not proxied by nginx (internal only).
- [ ] Child logger per socket carrying `socketId`, `userId`, `instanceId`; log disconnect reasons
- [ ] Compose healthchecks for `api1`/`api2` using `/ready`

**Tests:** spawn the server as a child process, connect a client, send `SIGTERM`, assert exit code 0, the client was disconnected, and `/ready` returned 503 during shutdown; metrics counters increase after a sent message.

**PR title:** `feat(infra): add graceful shutdown, metrics and structured socket logging`

**Phase 4 finished: tag `v0.5.0`.**

## 11. Phase 5 - Frontend

The backend contract is stable, so the UI is mostly binding `packages/client-core` and the REST API to screens.

**Phase decisions**

| # | Decision | Reason |
| --- | --- | --- |
| W1 | React 18 + Vite + TypeScript, React Router, TanStack Query, Zustand | light, common, matches the Project Doc |
| W2 | Tailwind CSS, `lucide-react` icons, no component library | fast styling, small bundle, no design rabbit hole |
| W3 | Plain controlled forms with the Zod schemas from `contracts` (no form library) | fewer dependencies, schemas are already written |
| W4 | **No list virtualization** in the MVP; pagination keeps loaded messages bounded | virtualizing a reverse-scrolling chat is a time sink; listed as post-MVP |
| W5 | Vite dev server proxies `/api` and `/socket.io` to `http://localhost:3000` (with `ws: true`) so everything is same-origin and the refresh cookie works | matches the production nginx layout |
| W6 | Access token lives **in memory only**; the refresh cookie restores the session on page load | XSS-safer than localStorage |

### T24 - Web app setup, API client, auth pages

**Branch:** `feat/t24-web-auth` | **Depends on:** T23

**Checklist**

- [ ] Scaffold `apps/web` (Vite react-ts), Tailwind, path aliases, depend on `@chat/contracts` and `@chat/client-core`
- [ ] Vite proxy config (decision W5)
- [ ] `api/http.ts`: fetch wrapper with base `/api/v1`, `credentials: 'include'`, bearer token from the auth store, error envelope parsed into a typed `ApiError`; on `401 TOKEN_EXPIRED` run **one shared refresh promise** (single flight, so parallel requests do not each refresh), then retry the original request once; if refresh fails, clear auth state
- [ ] `store/auth.ts` (Zustand): `user`, `accessToken`, `status: 'unknown' | 'authed' | 'anon'`; on app start call `/auth/refresh` then `/users/me` to restore the session
- [ ] Pages `/login` and `/register` with field-level errors (including server `details` such as "username taken"), loading and disabled states
- [ ] Route guards: `AuthGate` for private routes, redirect authed users away from auth pages
- [ ] Logout button calling `/auth/logout`
- [ ] `apps/web/Dockerfile` (build, then serve static files with nginx) and add the `web` service to `docker-compose.yml`; extend `infra/nginx.conf` so `/` goes to `web`

**Tests:** unit tests for the single-flight refresh (three parallel 401s cause one refresh call), `ApiError` parsing, and form validation messages (Testing Library).

**Done when:** you can register, reload the page and stay logged in, log out, and the app is reachable through nginx on `http://localhost:8080`.

**PR title:** `feat(web): add app shell, api client with refresh and auth pages`

### T25 - Chat list and new-chat flow

**Branch:** `feat/t25-web-chat-list` | **Depends on:** T24

**Checklist**

- [ ] `ChatLayout`: sidebar plus content area; routes `/` (empty state) and `/c/:conversationId`; on small screens show one pane at a time
- [ ] `useConversations` (TanStack infinite query on `GET /conversations` using `nextCursor`)
- [ ] `ConversationItem`: avatar with initials fallback, title (peer name or group name), preview (pure helper `previewText(message)`: deleted becomes "This message was deleted", system messages are italic, own messages prefixed with "You:"), relative time, unread badge, selected style
- [ ] "New chat" modal: user search with a 300 ms debounce hook, click calls `POST /conversations` (direct) and navigates to `/c/:id`
- [ ] Loading skeletons, empty states, error state with retry
- [ ] Refetch the list when the window regains focus (real-time updates come in T27)

**Tests:** `previewText`, debounce hook, list rendering with mocked API (MSW or a fetch mock).

**PR title:** `feat(web): add chat list and new direct chat flow`

### T26 - Conversation pane and history

**Branch:** `feat/t26-web-conversation` | **Depends on:** T25

**Checklist**

- [ ] `store/messages.ts`: `byConversation[id] = { byId, order (sorted by seq), lastSeq, hasMoreBefore }`; actions `upsertMessages` (uses `mergeMessages` from client-core), `markDeleted`, `reset`
- [ ] `ConversationHeader`: name, avatar, placeholder subtitle (presence arrives in T28)
- [ ] `MessageList`: loads the latest 30 on open; an `IntersectionObserver` sentinel at the top loads older pages with `beforeSeq`; **keeps scroll position** after prepending; auto-scrolls to the bottom for new messages only when the user was already near the bottom, otherwise shows a "jump to latest" button
- [ ] `MessageBubble`: own messages right, others left, sender name and avatar in groups, time, reply preview, deleted placeholder, centered system messages, date separators (pure helper `groupByDay`)
- [ ] `Composer` UI: auto-growing textarea, Enter sends and Shift+Enter inserts a newline, character counter shown after 3,500 chars, max 4,000 (send wiring comes in T27)

**Tests:** store merge and dedupe; `groupByDay`; scroll-position helper; message list renders deleted and system messages.

**PR title:** `feat(web): add conversation view with paginated history`

### T27 - Realtime send, optimistic UI, outbox

**Branch:** `feat/t27-web-realtime-send` | **Depends on:** T26

**Checklist**

- [ ] `RealtimeProvider`: creates one `ChatClient` when `status === 'authed'` and disposes it on logout; `useChatClient()` hook; `store/connection.ts` with `connecting | online | reconnecting | offline`
- [ ] Bind events: `message:new` upserts into the messages store and updates the chat list cache with `queryClient.setQueryData` (move the conversation to the top, update `lastMessage`, increment `unreadCount` unless that conversation is open); `message:deleted`; `conversation:created`, `conversation:updated`, `conversation:removed`
- [ ] Composer send calls `client.send(...)`: the message appears immediately as **sending**, is replaced by the server message on ack, and shows **failed** with Retry and Discard after the retries are exhausted
- [ ] Outbox persisted with the `sessionStorage` adapter so a page reload does not lose pending messages
- [ ] Reply: "Reply" action on a message sets a reply bar above the composer and sends `replyToId`; clicking a reply preview scrolls to the original when it is loaded
- [ ] Delete: message menu (own messages only) with confirm, uses `message:delete`

**Tests:** with a fake `ChatClient`: optimistic message replaced on ack; failure path; incoming event updates list ordering and unread counts; duplicate `message:new` for the same id is ignored.

**Done when:** two browsers chat in realtime and a message sent from one appears in the other's chat list and open conversation.

**PR title:** `feat(web): add realtime messaging with optimistic sends and outbox`

### T28 - Live state: ticks, typing, presence, unread

**Branch:** `feat/t28-web-live-state` | **Depends on:** T27

**Checklist**

- [ ] Status ticks on own messages using `deriveStatus(seq, receipts)`; keep a `receipts` entry per conversation updated by `message:status` events and by the initial `ConversationDto`
- [ ] **Auto read:** when the conversation is open, the tab is visible and the list is scrolled near the bottom, call `conversation:read` (debounced 300 ms) with the highest loaded `seq`; also on `visibilitychange`; reset the unread badge from the ack
- [ ] Typing: composer emits `typing:start` at most every 3 s while typing and `typing:stop` on send, blur or 5 s idle; header shows "typing..." (pure helper `typingText(names)`: "Alice is typing...", "Alice and Bob are typing...", "3 people are typing..."); each remote typing entry expires after 5 s
- [ ] Presence: `store/presence.ts` fed by `peerPresence`, `presence:update` and `GET /presence`; green dot on avatars; header shows "online" or "last seen ..." (pure helper `formatLastSeen`)
- [ ] Browser tab title shows the total unread count, for example `(3) Chat`

**Tests:** `typingText`, `formatLastSeen`, tick rendering for each status, auto-read fires only when the pane is visible and near the bottom.

**PR title:** `feat(web): add message status ticks, typing, presence and read tracking`

### T29 - Reconnect UX and gap fill

**Branch:** `feat/t29-web-reconnect` | **Depends on:** T28

**Checklist**

- [ ] `ConnectionBanner` driven by the connection store and `online` / `offline` window events ("Reconnecting...", "You are offline")
- [ ] On reconnect, `ChatClient.syncAll()` results are merged into the messages store and the list cache; unread badges are refreshed
- [ ] Failed-message UI: per-message Retry and a "Retry all" action in the banner
- [ ] `rate_limited` events show a small toast; expired refresh sends the user to `/login` with a message
- [ ] **Playwright E2E (decision: just this one scenario):** two browser contexts A and B; B goes offline; A sends 5 messages; B comes back online; assert B shows exactly those 5 messages in order, once, and A sees delivered/read ticks. Run it in CI as an optional job.
- [ ] Manual chaos demo documented in `docs/dev.md`: `docker stop` one API container while chatting; the client reconnects through nginx to the other instance and nothing is lost

**Done when:** toggling the browser offline and online, and stopping/starting an API instance, never loses or duplicates a message.

**PR title:** `feat(web): add reconnect handling, gap fill and offline resilience`

### T30 - Group chat UI

**Branch:** `feat/t30-web-groups` | **Depends on:** T29

**Checklist**

- [ ] `NewGroupModal`: name field, multi-select user search with chips, create calls `POST /conversations` (GROUP)
- [ ] `GroupInfoPanel`: members with role badges and online dots (via `/presence`), rename (admin or owner), add members, remove member, leave group with a confirm dialog
- [ ] Permission helpers `canRemove(actorRole, targetRole, isSelf)` and `canRename(role)` mirroring the server rules (the server stays the authority)
- [ ] Header and message bubbles show sender names in groups; `conversation:updated` and `conversation:removed` events update the UI (if you are removed while viewing, navigate home)

**Tests:** permission helpers (table-driven), removal while viewing the conversation.

**PR title:** `feat(web): add group creation, member management and group info`

**Phase 5 finished: tag `v0.9.0`.** The product works end to end.

## 12. Phase 6 - Quality and Release

### T31 - Test completion and edge cases

**Branch:** `test/t31-coverage-edge-cases` | **Depends on:** T30

**Checklist**

- [ ] **Authorization matrix test** (table-driven): every REST endpoint and socket event is called with no token, a non-member and a member, asserting the expected `401/403/404`
- [ ] Socket abuse tests: oversized payload, wrong types, unknown conversation ids, flooding events
- [ ] Compare the Project Doc 19 "Definition of Done" list with your tests; write any missing test
- [ ] Coverage report in CI (artifact). **Decision:** aim for solid coverage of services and handlers (about 80%), do not chase 100%.
- [ ] `docs/security.md` ticking each item of Project Doc 14 with where it is implemented
- [ ] `pnpm audit` clean (or documented exceptions); add `.github/dependabot.yml`
- [ ] CI additions: web build job, optional Playwright job
- [ ] Fix every bug found, each in its own `fix:` commit

**PR title:** `test: add authorization matrix, abuse tests and security review`

### T32 - Load test and results

**Branch:** `feat/t32-load-test` | **Depends on:** T31

**Decision:** k6 does not speak the Socket.IO framing natively, so the load generator is a small **Node script** using `socket.io-client` (`scripts/loadtest/`). It is simpler and exercises the real protocol.

**Checklist**

- [ ] Script `seed-load-users` creates N users (default 1,000) and pairs them into direct chats
- [ ] Script `run-load` ramps virtual users up to N over 60 s; each opens a socket through nginx and sends one message every 5 s for 5 minutes. Message content carries a send timestamp so the receiver can compute **delivery latency**; ack time gives **ack latency**
- [ ] Output: connected sockets, messages sent and received, errors, ack and delivery latency p50, p95, p99, and server CPU and memory from `docker stats`
- [ ] Run twice: with one API instance and with two (stop `api2` for the first run) and compare
- [ ] Document the machine, `ulimit -n`, Docker limits and anything you tuned in `docs/load-test.md`
- [ ] Fix any bottleneck found (typical suspects: Prisma pool size, missing index, event loop blocking) and record before/after numbers
- [ ] Targets from Project Doc 2.2: delivery p95 under 200 ms and 1,000 or more sockets per instance. If you miss them, report the real numbers and the cause; honest numbers are fine.

**PR title:** `feat(perf): add socket load generator and document results`

### T33 - README, docs and release

**Branch:** `docs/t33-readme-release` | **Depends on:** T32

**Checklist**

- [ ] `README.md` following Project Doc 20: pitch, CI badge, demo GIF (two browser windows chatting plus a reconnect), features, **Mermaid architecture diagram** (renders on GitHub), tech stack, quick start (`cp .env.example .env && docker compose up --build`, URL, seeded accounts), key design decisions (copy the decision log), testing, load test table, known limitations, project structure
- [ ] `docs/`: `architecture.md`, `api.md` (endpoint table), `socket-events.md`, `dev.md`, `scaling.md`, `load-test.md`, `security.md`
- [ ] Include the final Project Document and this workflow under `docs/` (as Markdown exports)
- [ ] Repo polish: description, topics, social preview image, pinned on your profile
- [ ] Walk through the full MVP checklist in section 14 on a clean clone using only the README
- [ ] Tag `v1.0.0` and create the GitHub Release with notes
- [ ] **Optional:** deploy a demo (for example Fly.io or Render for the API and worker, Neon for PostgreSQL, Upstash for Redis) and link it in the README; skip if it costs time you need elsewhere

**PR title:** `docs: add README, architecture docs and release v1.0.0`

**Phase 6 finished: tag `v1.0.0`. The MVP is done.**

## 13. Appendices

### 13.1 Suggested schedule (part-time, about 10 to 12 hours per week)

| Week | Tasks | Milestone |
| --- | --- | --- |
| 1 | T00 to T04 | tooling, DB, CI green |
| 2 | T05 to T08 | complete auth |
| 3 | T09 to T13 | full REST core |
| 4 | T14 to T16 | live messaging with statuses |
| 5 | T17 to T20 | delete, typing, presence, reliable reconnect |
| 6 | T21 to T23 | two instances, workers, shutdown |
| 7 | T24 to T26 | web login, chat list, history |
| 8 | T27 to T29 | realtime UI and resilience |
| 9 | T30 to T33 | groups UI, tests, load test, README |

Full-time, the same plan takes about 3 to 4 weeks. Do not compress T15, T16 and T20; they hold the core engineering value.

### 13.2 If time runs short: what to cut (in this order)

1. Playwright test in T29 (keep the manual chaos demo)
2. Metrics in T23 (keep graceful shutdown)
3. `unread-reconcile` job in T22
4. Group UI in T30 (groups still work through REST and tests)
5. Load test scale (run 200 sockets instead of 1,000, but keep the report)

**Never cut:** T14 to T16, T20, T21 and the README. Together they prove the realtime and scaling skills.

### 13.3 Dependency chain

`T00 > T01 > T02 > T03 > T04 > T05 > T06 > T07 > T08 > T09 > T10 > T11 > T12 > T13 > T14 > T15 > T16 > T17 > T18 > T19 > T20 > T21 > T22 > T23 > T24 > T25 > T26 > T27 > T28 > T29 > T30 > T31 > T32 > T33`

The chain is strictly linear on purpose (one person, one task at a time). Tasks that could run in parallel with a team: T17/T18 after T16, T22 after T21, and the whole web app (T24 to T30) after T20.

### 13.4 Clarifications to the roadmap table

- T11 also creates the `RealtimeGateway` interface and `allocateSeq`; T14 implements the gateway.
- T14 also moves the socket event types into `contracts` and adds the `handle()` wrapper used by every handler.
- T16 and T19 extend `ConversationDto` (`receipts`, `peerPresence`); update the mapper and the chat list when you do.
- T20 creates `packages/client-core` in addition to the server-side proofs; add it to `pnpm-workspace.yaml` packages.

### 13.5 Command cheat sheet

```bash
# infra
docker compose -f docker-compose.dev.yml up -d      # postgres + redis for development
docker compose up --build                            # full stack (from T21)

# database
pnpm db:migrate        # prisma migrate dev
pnpm db:reset          # reset + seed
pnpm prisma studio

# quality
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter api test -- --watch

# git
git switch main && git pull && git switch -c feat/tNN-name
gh pr create --fill --label feat,backend
git tag v0.X.0 && git push --tags
```

## 14. MVP Acceptance Checklist

Tick each item on a clean clone, using only the README, before tagging `v1.0.0`.

- [ ] `docker compose up --build` starts postgres, redis, migrations, two APIs, worker, web and nginx (T21, T22, T24)
- [ ] Register, log in, reload and stay logged in, log out (T05 to T07, T24)
- [ ] Search a user and start a direct chat (T09, T10, T25)
- [ ] Messages arrive instantly in the other browser, with correct order (T15, T27)
- [ ] Replies and deleting your own message work (T15, T17, T27)
- [ ] Sent, delivered and read ticks update correctly (T16, T28)
- [ ] Typing indicator and online or last seen work, including with two tabs (T18, T19, T28)
- [ ] Go offline, receive messages from the other side, come back: all arrive in order, exactly once (T20, T29)
- [ ] Retrying a send never duplicates a message (T15, T20)
- [ ] Groups: create, rename, add and remove members, leave (T11, T30)
- [ ] Stopping one API container keeps the chat working (T21, T29)
- [ ] Non-members cannot read or send anywhere (T31)
- [ ] CI is green, load test results and the README are published (T04, T32, T33)
