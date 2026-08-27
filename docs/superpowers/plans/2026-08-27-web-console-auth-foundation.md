# Web Console Authentication Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace shared Web-console token authentication with one first-run administrator account, 30-day cookie sessions, CSRF/WS nonce protection, a stable server data path, and user ownership on existing terminal/filesystem resources.

**Architecture:** Add user/auth-session domain records and a SQLite repository in core, then compose password/session services and HTTP routes in the server. The browser authenticates through HttpOnly cookies and bootstraps a short-lived WebSocket nonce. Existing PTYs remain in the current gateway map for this phase, but every terminal and cwd-derived filesystem root is tagged and checked against the authenticated user.

**Tech Stack:** TypeScript, Node.js `crypto.scrypt`, better-sqlite3, Next.js 14 App Router, React 18, ws, Vitest.

## Global Constraints

- First release permits exactly one administrator account; schema still carries stable `user_id`.
- First-user setup is available only while `users` is empty and must be transaction-safe.
- Password length is at least 10 characters and password hashes use versioned scrypt parameters.
- Login sessions use opaque random tokens, persist only SHA-256 hashes, and expire after 30 days of sliding inactivity.
- Cookies are `HttpOnly; SameSite=Strict; Path=/`; add `Secure` under HTTPS.
- State-changing HTTP routes require a CSRF token; WebSocket upgrade requires cookie authentication, expected Origin, and a one-time nonce.
- `AGENT_WEB_TOKEN` and browser localStorage tokens are removed from the Web-console flow.
- Filesystem cwd expansion is scoped to terminals owned by the authenticated user.
- This phase does not add multi-terminal channel multiplexing; that is Phase 2.
- Do not commit `.env.local`, `.next`, `.sessions`, API keys, cookies, auth tokens, or database files.

---

## File Structure

### Core domain and persistence

- Create `packages/core/src/domain/auth/entities.ts`: `User`, `AuthSession`, setup/login input types.
- Create `packages/core/src/domain/auth/AuthStore.ts`: repository interface.
- Create `packages/core/src/domain/auth/password.ts`: versioned scrypt hash/verify.
- Create `packages/core/src/domain/auth/WebAuthService.ts`: setup/login/session/CSRF service shared by Next and the Node Gateway.
- Create `packages/core/src/domain/auth/index.ts`: auth exports.
- Create `packages/core/src/infrastructure/SQLiteAuthStore.ts`: transactional SQLite implementation.
- Modify `packages/core/src/infrastructure/SQLiteDatabase.ts`: users/auth_sessions/login_attempts migrations.
- Modify `packages/core/src/infrastructure/index.ts` and `packages/core/src/index.ts`: exports.

### Server auth and API

- Create `packages/server/lib/server-data-dir.ts`: deterministic `AGENT_DATA_DIR` resolution.
- Create `packages/server/lib/web-auth/http.ts`: Next Request/Cookie/CSRF helpers around core `WebAuthService`.
- Create `packages/server/app/api/web-auth/status/route.ts`.
- Create `packages/server/app/api/web-auth/setup/route.ts`.
- Create `packages/server/app/api/web-auth/login/route.ts`.
- Create `packages/server/app/api/web-auth/logout/route.ts`.
- Create `packages/server/app/api/web-auth/revoke-all/route.ts`.
- Create `packages/server/app/api/web-console/bootstrap/route.ts`.
- Modify `packages/server/app/api/agent-host.ts`: stable data base directory.
- Modify `packages/server/ws-server.mjs`: cookie/nonce authentication and temporary terminal ownership checks.

### Browser

- Create `packages/server/app/web/useWebAuth.ts`: status/setup/login/logout/bootstrap state.
- Create `packages/server/app/web/AuthGate.tsx`: first-run setup and login UI.
- Modify `packages/server/app/web/useGateway.ts`: cookie + nonce WebSocket connection.
- Modify `packages/server/app/web/page.tsx`: render through `AuthGate` and remove token UI.

---

### Task 1: Add Auth Schema and Domain Contracts

**Files:**
- Create: `packages/core/src/domain/auth/entities.ts`
- Create: `packages/core/src/domain/auth/AuthStore.ts`
- Create: `packages/core/src/domain/auth/index.ts`
- Modify: `packages/core/src/infrastructure/SQLiteDatabase.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/infrastructure/SQLiteAuthStore.test.ts` (schema assertions start here)

**Interfaces:**
- Produces `User`, `AuthSession`, `CreateUserInput`, `CreateAuthSessionInput`.
- Produces `AuthStore` with the signatures used by Tasks 2–6.

- [ ] **Step 1: Write failing migration and contract tests**

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabase } from "./SQLiteDatabase.js";

describe("auth schema", () => {
  it("creates users, auth_sessions, and login_attempts", () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-auth-"));
    const database = new SQLiteDatabase(base);
    const tables = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining(["users", "auth_sessions", "login_attempts"]),
    );
    database.close();
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
bunx vitest run packages/core/src/infrastructure/SQLiteAuthStore.test.ts
```

Expected: FAIL because the auth tables do not exist.

- [ ] **Step 3: Define domain contracts**

```ts
export interface User {
  id: string;
  usernameNormalized: string;
  usernameDisplay: string;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  passwordVersion: number;
  createdAt: string;
  passwordChangedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: Buffer;
  csrfHash: Buffer;
  wsNonceHash: Buffer | null;
  wsNonceExpiresAt: string | null;
  deviceId: string;
  deviceName: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export type CreateUserInput = User;
export type CreateAuthSessionInput = AuthSession;
```

```ts
export interface AuthStore {
  countUsers(): number;
  createFirstUser(input: CreateUserInput): User;
  findUserById(id: string): User | null;
  findUserByNormalizedUsername(username: string): User | null;
  createSession(input: CreateAuthSessionInput): AuthSession;
  findSessionByTokenHash(tokenHash: Buffer, now: string): AuthSession | null;
  rotateCsrf(sessionId: string, csrfHash: Buffer, lastSeenAt: string, expiresAt: string): void;
  issueWsNonce(sessionId: string, nonceHash: Buffer, expiresAt: string): void;
  consumeWsNonce(sessionId: string, nonceHash: Buffer, now: string): boolean;
  revokeSession(sessionId: string, revokedAt: string): void;
  revokeUserSessions(userId: string, exceptSessionId: string | null, revokedAt: string): number;
  recordLoginFailure(usernameNormalized: string, ip: string, attemptedAt: string): void;
  countRecentLoginFailures(usernameNormalized: string, ip: string, since: string): number;
  clearLoginFailures(usernameNormalized: string, ip: string): void;
}
```

- [ ] **Step 4: Add migrations**

Add tables with foreign keys and indexes matching the approved design. `createFirstUser` must later use a transaction and a `SELECT COUNT(*)` guard.

- [ ] **Step 5: Run tests**

Run:

```bash
bunx vitest run packages/core/src/infrastructure/SQLiteAuthStore.test.ts
```

Expected: PASS for schema creation.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/domain/auth packages/core/src/infrastructure/SQLiteDatabase.ts packages/core/src/infrastructure/SQLiteAuthStore.test.ts packages/core/src/index.ts
git commit -m "feat: add web auth schema"
```

### Task 2: Implement SQLiteAuthStore and Password Security

**Files:**
- Create: `packages/core/src/infrastructure/SQLiteAuthStore.ts`
- Create: `packages/core/src/domain/auth/password.ts`
- Modify: `packages/core/src/infrastructure/index.ts`
- Test: `packages/core/src/infrastructure/SQLiteAuthStore.test.ts`
- Test: `packages/core/src/domain/auth/password.test.ts`

**Interfaces:**
- Consumes `AuthStore` and auth entities from Task 1.
- Produces `SQLiteAuthStore`.
- Produces `hashPassword(password)` and `verifyPassword(password, hash, salt, version)`.

- [ ] **Step 1: Add failing repository tests**

Cover:

```ts
it("atomically creates only one first user", () => {
  const first = store.createFirstUser(input);
  expect(first.usernameNormalized).toBe("caoqu");
  expect(() => store.createFirstUser({ ...input, id: "second" })).toThrow("setup already completed");
});

it("returns only non-revoked, non-expired sessions by token hash", () => {
  store.createSession(sessionInput);
  expect(store.findSessionByTokenHash(sessionInput.tokenHash, now)?.id).toBe(sessionInput.id);
  store.revokeSession(sessionInput.id, now);
  expect(store.findSessionByTokenHash(sessionInput.tokenHash, now)).toBeNull();
});

it("counts failures by username and ip inside a time window", () => {
  store.recordLoginFailure("caoqu", "127.0.0.1", now);
  expect(store.countRecentLoginFailures("caoqu", "127.0.0.1", beforeNow)).toBe(1);
});
```

- [ ] **Step 2: Add failing password tests**

```ts
it("hashes and verifies a password without storing plaintext", async () => {
  const record = await hashPassword("correct horse battery staple");
  expect(record.hash.toString("utf8")).not.toContain("correct horse");
  await expect(verifyPassword("correct horse battery staple", record)).resolves.toBe(true);
  await expect(verifyPassword("wrong password", record)).resolves.toBe(false);
});
```

- [ ] **Step 3: Run tests and verify failure**

```bash
bunx vitest run packages/core/src/infrastructure/SQLiteAuthStore.test.ts packages/core/src/domain/auth/password.test.ts
```

- [ ] **Step 4: Implement SQLiteAuthStore**

Use prepared statements and a better-sqlite3 transaction for first-user creation. Convert BLOB columns to `Buffer` without string round-trips.

- [ ] **Step 5: Implement versioned scrypt**

```ts
export interface PasswordRecord {
  hash: Buffer;
  salt: Buffer;
  version: number;
}

export const PASSWORD_VERSION = 1;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<PasswordRecord>;
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean>;
```

Use 16 random salt bytes, a 32-byte derived key, and `timingSafeEqual`.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run packages/core/src/infrastructure/SQLiteAuthStore.test.ts packages/core/src/domain/auth/password.test.ts
git add packages/core/src/infrastructure/SQLiteAuthStore.ts packages/core/src/infrastructure/SQLiteAuthStore.test.ts packages/core/src/infrastructure/index.ts packages/core/src/domain/auth/password.ts packages/core/src/domain/auth/password.test.ts
git commit -m "feat: implement secure auth storage"
```

### Task 3: Add Stable Server Data Path and WebAuthService

**Files:**
- Create: `packages/server/lib/server-data-dir.ts`
- Create: `packages/core/src/domain/auth/WebAuthService.ts`
- Create: `packages/server/lib/web-auth/http.ts`
- Modify: `packages/server/app/api/agent-host.ts`
- Test: `packages/server/lib/server-data-dir.test.ts`
- Test: `packages/core/src/domain/auth/WebAuthService.test.ts`

**Interfaces:**
- Produces `getServerBaseDir(): string`.
- Produces core `WebAuthService.setup`, `.login`, `.authenticateToken`, `.refresh`, `.logout`, `.revokeAll`.
- Produces `requirePrincipal(request): Promise<WebPrincipal>`.

- [ ] **Step 1: Write failing data-path tests**

```ts
it("uses AGENT_DATA_DIR regardless of process cwd", () => {
  expect(resolveServerBaseDir({ AGENT_DATA_DIR: "/tmp/customer-agent-data" }, "/app/server"))
    .toBe("/tmp/customer-agent-data");
});

it("defaults to the server package directory", () => {
  expect(resolveServerBaseDir({}, "/app/server")).toBe("/app/server");
});
```

- [ ] **Step 2: Write failing session-service tests**

Cover password length, username normalization, first setup, rate limit `5/15m`, opaque 32-byte auth token, SHA-256 token hash, CSRF rotation, 30-day expiry, logout, and revoke-all-except-current.

Also cover one-time WebSocket nonce issuance: persist only its SHA-256 hash and expiry, consume it transactionally once, reject reuse, and reject expired nonces.

- [ ] **Step 3: Run tests and verify failure**

```bash
bunx vitest run packages/server/lib/server-data-dir.test.ts packages/core/src/domain/auth/WebAuthService.test.ts
```

- [ ] **Step 4: Implement deterministic base directory**

Derive the server package path from `import.meta.url` in `ws-server.mjs`, and pass it to shared helpers. Import and use `getServerBaseDir()` in AgentHost so every server store uses the same explicit base directory instead of `process.cwd()`.

- [ ] **Step 5: Implement WebAuthService in core**

```ts
export interface LoginResult {
  user: { id: string; username: string };
  sessionId: string;
  authToken: string;
  csrfToken: string;
  expiresAt: string;
  deviceId: string;
}

export interface WebPrincipal {
  userId: string;
  username: string;
  sessionId: string;
  deviceId: string;
}
```

Generate raw auth/CSRF tokens only in memory and return them once. Persist their hashes.

- [ ] **Step 6: Implement Next HTTP helpers**

`packages/server/lib/web-auth/http.ts` wraps core `WebAuthService` for Next Request/Response usage. Cookie name: `customer_agent_session`. Device cookie: `customer_agent_device`. Origin validation accepts the current request host and explicit `AGENT_WEB_ALLOWED_ORIGINS` entries. The native Node Gateway imports `WebAuthService` and `SQLiteAuthStore` from compiled `@agent/core`; it must not import server TypeScript directly.

- [ ] **Step 7: Run tests and commit**

```bash
bunx vitest run packages/server/lib/server-data-dir.test.ts packages/core/src/domain/auth/WebAuthService.test.ts
git add packages/core/src/domain/auth/WebAuthService.ts packages/core/src/domain/auth/WebAuthService.test.ts packages/core/src/domain/auth/index.ts packages/server/lib/server-data-dir.ts packages/server/lib/server-data-dir.test.ts packages/server/lib/web-auth/http.ts packages/server/app/api/agent-host.ts
git commit -m "feat: add web auth session service"
```

### Task 4: Add Setup, Login, Logout, and Bootstrap APIs

**Files:**
- Create: `packages/server/app/api/web-auth/status/route.ts`
- Create: `packages/server/app/api/web-auth/setup/route.ts`
- Create: `packages/server/app/api/web-auth/login/route.ts`
- Create: `packages/server/app/api/web-auth/logout/route.ts`
- Create: `packages/server/app/api/web-auth/revoke-all/route.ts`
- Create: `packages/server/app/api/web-console/bootstrap/route.ts`
- Test: `packages/server/app/api/web-auth/routes.test.ts`

**Interfaces:**
- Consumes core `WebAuthService` and Next HTTP helpers from Task 3.
- Produces the browser API used by Task 5.

- [ ] **Step 1: Write failing route-handler tests**

Use direct route function invocation with Request objects. Cover:

```text
GET status before setup       → 200 {needsSetup:true, authenticated:false}
POST setup valid              → 201 + cookie + csrfToken
POST setup second time        → 409
POST login wrong password     → 401
POST login sixth failure      → 429
POST login valid              → 200 + cookie + csrfToken
POST logout without CSRF      → 403
POST logout valid             → 204 + expired cookie
GET bootstrap authenticated   → user/device/nonce payload
```

- [ ] **Step 2: Run tests and verify failure**

```bash
bunx vitest run packages/server/app/api/web-auth/routes.test.ts
```

- [ ] **Step 3: Implement route handlers**

Return stable error bodies:

```ts
{ error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" } }
```

Setup and login set the HttpOnly auth cookie and stable device cookie. Bootstrap rotates CSRF and returns a one-time WebSocket nonce with a 60-second expiry.

- [ ] **Step 4: Run tests and commit**

```bash
bunx vitest run packages/server/app/api/web-auth/routes.test.ts
git add packages/server/app/api/web-auth/status/route.ts packages/server/app/api/web-auth/setup/route.ts packages/server/app/api/web-auth/login/route.ts packages/server/app/api/web-auth/logout/route.ts packages/server/app/api/web-auth/revoke-all/route.ts packages/server/app/api/web-console/bootstrap/route.ts packages/server/app/api/web-auth/routes.test.ts
git commit -m "feat: add web account APIs"
```

### Task 5: Replace Token UI with Setup/Login AuthGate

**Files:**
- Create: `packages/server/app/web/useWebAuth.ts`
- Create: `packages/server/app/web/AuthGate.tsx`
- Modify: `packages/server/app/web/page.tsx`
- Test: `packages/server/app/web/useWebAuth.test.ts`

**Interfaces:**
- Consumes Task 4 routes.
- Produces `{ status, user, csrfToken, wsNonce, setup(), login(), logout(), refreshBootstrap() }`.

- [ ] **Step 1: Write failing hook-state tests**

Cover transitions:

```text
loading → needsSetup
loading → needsLogin
loading → authenticated
invalid login → form error without clearing username
successful setup/login → authenticated bootstrap
logout → needsLogin
```

- [ ] **Step 2: Run tests and verify failure**

```bash
bunx vitest run packages/server/app/web/useWebAuth.test.ts
```

- [ ] **Step 3: Implement useWebAuth**

All fetches use `credentials: "same-origin"`. Keep CSRF only in React memory. Do not write auth material to localStorage/sessionStorage.

- [ ] **Step 4: Implement AuthGate**

Render three states:

- loading indicator;
- one-time administrator setup form;
- username/password login form.

After authentication render the existing remote console. Remove token input, token localStorage key, and token instructions.

- [ ] **Step 5: Run tests, TypeScript, and commit**

```bash
bunx vitest run packages/server/app/web/useWebAuth.test.ts
bunx tsc --noEmit
git add packages/server/app/web/useWebAuth.ts packages/server/app/web/useWebAuth.test.ts packages/server/app/web/AuthGate.tsx packages/server/app/web/page.tsx
git commit -m "feat: add web console login"
```

### Task 6: Authenticate WebSocket with Cookie and Nonce

**Files:**
- Modify: `packages/server/ws-server.mjs`
- Modify: `packages/server/app/web/useGateway.ts`
- Test: `packages/server/ws-auth.integration.test.mjs`

**Interfaces:**
- Consumes core `WebAuthService.authenticateToken()` and bootstrap `wsNonce`.
- Produces authenticated connection context `{ principal, terminals, filesystemRoots }`.

- [ ] **Step 1: Write a failing WebSocket integration test**

Test cases:

```text
no cookie                         → close 4001
valid cookie, no nonce            → close 4003
valid cookie, wrong Origin        → HTTP/WS rejection
valid cookie + nonce              → connection:hello with userId/deviceId
nonce reuse                       → close 4003
```

- [ ] **Step 2: Run test and verify failure**

```bash
node packages/server/ws-auth.integration.test.mjs
```

- [ ] **Step 3: Implement server handshake**

Remove `AGENT_WEB_TOKEN`, `auth:required`, and `{type:"auth", token}` handling. Parse cookies from the upgrade request, validate session and origin, then consume the one-time nonce from the first control frame before enabling terminal/filesystem commands.

- [ ] **Step 4: Update useGateway**

```ts
new WebSocket(`${wsBaseUrl()}?nonce=${encodeURIComponent(wsNonce)}`)
```

The browser relies on the HttpOnly cookie automatically. Auth close codes transition to `needsLogin` through `useWebAuth`, not a token prompt or reconnect loop.

- [ ] **Step 5: Run integration and TypeScript checks**

```bash
node packages/server/ws-auth.integration.test.mjs
bunx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/ws-server.mjs packages/server/app/web/useGateway.ts packages/server/ws-auth.integration.test.mjs
git commit -m "feat: secure web console websocket"
```

### Task 7: Add Interim User Ownership to Existing Terminal and Filesystem Paths

**Files:**
- Modify: `packages/server/ws-server.mjs`
- Test: `packages/server/ws-ownership.integration.test.mjs`

**Interfaces:**
- Consumes authenticated `conn.principal.userId` from Task 6.
- Produces ownership checks that Phase 2 TerminalHub must preserve.

- [ ] **Step 1: Write failing ownership tests**

Create two connection fixtures with distinct synthetic principals and assert:

```text
user A creates terminal A
user B cannot attach/input/resize/kill terminal A
user B filesystem roots do not include terminal A cwd
user A can use terminal A cwd
```

Although Phase 1 exposes one administrator account, the ownership test injects two principal IDs directly to prove the boundary before future multi-user support; it does not create a second login account.

- [ ] **Step 2: Run and verify failure**

```bash
node packages/server/ws-ownership.integration.test.mjs
```

- [ ] **Step 3: Add ownership to current session objects**

Add `userId` to the temporary in-memory `TerminalSession` shape. Every `term:*` handler retrieves through:

```js
function requireOwnedTerminal(conn, terminalId) {
  const session = terminals.get(terminalId);
  if (!session || session.userId !== conn.principal.userId) {
    throw Object.assign(new Error("terminal not found"), { code: "ENOSESSION" });
  }
  return session;
}
```

Filter active cwd roots by `session.userId === conn.principal.userId`. Avoid revealing whether another user's terminal ID exists.

- [ ] **Step 4: Run tests and commit**

```bash
node packages/server/ws-ownership.integration.test.mjs
bunx tsc --noEmit
git add packages/server/ws-server.mjs packages/server/ws-ownership.integration.test.mjs
git commit -m "fix: isolate web terminal ownership"
```

### Task 8: Phase 1 Regression and Security Verification

**Files:**
- Read-only verification task. A defect returns to the task that owns the affected files and follows that task's test/commit cycle.

**Interfaces:**
- Validates all Phase 1 deliverables before Phase 2 planning.

- [ ] **Step 1: Run focused tests**

```bash
bunx vitest run \
  packages/core/src/infrastructure/SQLiteAuthStore.test.ts \
  packages/core/src/domain/auth/password.test.ts \
  packages/server/lib/server-data-dir.test.ts \
  packages/core/src/domain/auth/WebAuthService.test.ts \
  packages/server/app/api/web-auth/routes.test.ts \
  packages/server/app/web/useWebAuth.test.ts
node packages/server/ws-auth.integration.test.mjs
node packages/server/ws-ownership.integration.test.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run existing regressions**

```bash
bunx vitest run packages/core/src/domain/terminal
bunx tsc --noEmit
bun run --cwd packages/core build
bun run --cwd packages/server build
```

Expected: all PASS. If better-sqlite3 ABI prevents a test runtime, rebuild for the selected Node runtime and record the runtime rather than changing production logic.

- [ ] **Step 3: Browser E2E**

Verify with a fresh isolated browser context:

1. First visit shows setup.
2. Setup creates the only account and opens the console.
3. Logout returns to login.
4. Wrong password stays logged out.
5. Correct login restores access without Web token.
6. Reload and a second tab reuse the cookie without login.
7. Revoking all devices logs out the other tab.
8. Terminal, cwd-following tree, file preview, mobile keyboard, and TUI scroll still work.

- [ ] **Step 4: Inspect secrets and diff**

```bash
git diff --check
```

Expected: `.env.local`, database files, cookies, and runtime artifacts are not staged.

## Phase Completion Gate

Do not start TerminalHub multiplexing until:

- login/setup/session tests pass;
- cookie + nonce WebSocket integration passes;
- terminal/filesystem ownership tests pass;
- the browser no longer stores or asks for `AGENT_WEB_TOKEN`;
- existing one-terminal mobile and file workflows pass E2E;
- the user reviews the Phase 1 result.
