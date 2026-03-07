# Build Plan: Multi-Tenancy Safety Fixes
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/multi-tenancy-audit-brainstorm-2026-03-07.md
**Status:** Draft

## Overview
Fix all multi-tenancy isolation gaps identified in the audit. One owner per repo URL. MCP server must support multi-tenant auth. API key and dev mode auth must be compatible with RLS-protected routes.

## Decisions
- **Repo sharing:** One owner per URL. Keep unique `url` constraint. Reject digest attempts for repos owned by another user.
- **MCP server:** Must be multi-tenant capable. Accept user access tokens.
- **Neo4j:** API-layer enforcement is sufficient. No `owner_id` in graph nodes — too invasive for the benefit. Ensure all API paths check ownership via Supabase RLS before touching Neo4j.

## Component Inventory

| Component | Current State | Target State |
|-----------|--------------|--------------|
| `digest.ts` repo upsert | Overwrites owner_id on conflict | Reject if owned by different user |
| Auth middleware (index.ts) | API key skips user setup | API key + dev mode set req.user |
| SyncManager | Uses service key, no tenant checks | Receives user-scoped client or validates ownership |
| MCP server | Service key, no tenant isolation | Accepts user token, creates user-scoped client |
| Webhook handler | Service key repo lookup | Acceptable (signature-validated), no change |
| connections.ts upsert | Service key write | Acceptable (sets correct owner_id), no change |
| Background processes | Service key | Acceptable (admin operations), no change |

## Integration Contracts

### Contract 1: Digest Ownership Guard
```
POST /api/digest → runDigest()
  What flows:     DigestRequest with ownerId (from req.user.id)
  Guard:          Before upsert, SELECT owner_id FROM repositories WHERE url = $url
                  If exists AND owner_id != req.ownerId AND owner_id IS NOT NULL → 403
                  If exists AND owner_id IS NULL → claim it (set owner_id)
                  If not exists → insert with owner_id
  Error path:     403 { error: "Repository is owned by another user", code: "REPO_OWNED" }
```

### Contract 2: API Key Auth → User Context
```
Auth Middleware → req.user
  What flows:     API key token in Authorization header
  How:            API key auth sets a service-level user on req.user with a
                  dedicated service account UUID (from env or config)
  Config needed:  REPOGRAPH_SERVICE_USER_ID env var (Supabase Auth UUID of the
                  service account that "owns" API-key-created resources)
  Fallback:       If no service user configured, API key auth still succeeds
                  but req.user remains null — routes that need getUserDb will
                  return 401 instead of 500
  Error path:     Routes check getUser(req) and return 401 if null
```

### Contract 3: Dev Mode Auth → Mock User
```
Auth Middleware (dev mode) → req.user
  What flows:     No auth headers, dev mode detected
  How:            Set req.user to a dev user with a deterministic UUID
                  (e.g., "00000000-0000-0000-0000-000000000000")
  Config needed:  None — only activates when !config.apiKey && !config.supabase.anonKey
  Important:      Dev mode must also use service key Supabase client for DB
                  (since there's no real JWT for RLS). Routes need a getUserDb
                  variant that returns service client in dev mode.
  Error path:     None — dev mode always succeeds
```

### Contract 4: MCP Server Per-User Auth
```
MCP Server init → user-scoped Supabase client
  What flows:     User's Supabase access token
  How:            New env var REPOGRAPH_USER_TOKEN. If set, create user-scoped
                  client (anon key + user JWT). If not set, fall back to
                  service key with a warning.
  Config needed:  REPOGRAPH_USER_TOKEN, SUPABASE_ANON_KEY env vars
  Guard:          All Supabase queries go through user-scoped client → RLS enforced
  Neo4j:          Still uses repo_url scoping. MCP resolves repo by name/URL
                  through user-scoped Supabase (RLS filters to owned repos only),
                  then queries Neo4j with the resolved URL.
  Error path:     If token is expired/invalid, tool returns auth error message
```

### Contract 5: SyncManager Ownership Safety
```
SyncManager methods → tenant-safe queries
  What flows:     repoId (already ownership-verified by caller)
  How:            Two options (pick one):
    Option A:     Accept SupabaseClient as parameter, caller passes getUserDb result
    Option B:     Keep service key but add assertion: before operating on a repo,
                  verify the route already checked ownership (trust-but-verify pattern)
  Chosen:         Option A for getStatus/getEvents (read paths).
                  Keep service key for trigger/executeDigest (write paths that
                  need to create sync_events, which the user's RLS client can't
                  insert into without matching repo_id ownership).
  Error path:     If repoId doesn't exist in user-scoped query, return 404
```

## End-to-End Flows

### Flow 1: Authenticated Digest (Happy Path)
1. Frontend sends POST /api/digest with Supabase JWT
2. Auth middleware verifies JWT, sets req.user ✅
3. Route handler calls `getUser(req)` → gets user.id
4. Calls `runDigest({ url, branch, ownerId: user.id })`
5. **NEW:** runDigest checks if repo exists with different owner → 403 if so
6. Upserts repo with owner_id
7. Pipeline runs (service key for writes — correct)
8. User can see repo via RLS ✅

### Flow 2: Authenticated Digest (Ownership Conflict)
1. User B sends POST /api/digest for a URL owned by User A
2. Auth middleware sets req.user to User B ✅
3. runDigest checks: `SELECT owner_id FROM repositories WHERE url = $url`
4. Finds owner_id = User A's ID, which != User B's ID
5. **Returns 403 { error: "Repository is owned by another user" }**
6. User B's request is rejected, User A's data is safe ✅

### Flow 3: API Key Access
1. Client sends request with API key in Authorization header
2. Auth middleware matches API key, sets req.user to service user ✅
3. Route handler calls getUserDb(req) → gets service user's client
4. **NEW:** getUserDb returns service-key client when user is the service account
5. All queries run with service key (admin access) ✅

### Flow 4: MCP Server Query
1. MCP tool called with repo name
2. **NEW:** resolveRepoId uses user-scoped Supabase client
3. RLS filters to repos owned by the token's user
4. If repo found, query Neo4j with the resolved repo_url
5. Return results ✅

### Flow 5: Dev Mode
1. Dev sends request with no auth headers, no keys configured
2. Auth middleware detects dev mode, sets req.user to mock dev user ✅
3. **NEW:** getUserDb detects dev user, returns service-key client
4. All queries run with service key (no RLS in dev) ✅

## Issues Found → Fix Mapping

| Issue | Severity | Fix | Phase |
|-------|----------|-----|-------|
| CRITICAL-1: Ownership theft | Critical | Ownership guard in runDigest | 1 |
| CRITICAL-2: API key broken | Critical | Set service user on req.user | 1 |
| HIGH-3: Dev mode broken | High | Set mock user on req.user | 1 |
| CRITICAL-3: MCP no tenant | Critical | User-scoped Supabase client | 2 |
| HIGH-2: SyncManager fragile | High | Pass user-scoped client to read methods | 3 |
| HIGH-1: Neo4j no tenant | High | No code change — API-layer enforcement + doc | 3 |
| MEDIUM-1: Webhook info leak | Medium | No change — acceptable risk | — |
| MEDIUM-2: connections upsert | Medium | No change — functionally safe | — |

## Wiring Checklist

### Phase 1: Auth & Ownership Foundation
- [ ] **1.1** Add ownership guard in `runDigest()` — before upsert, query existing repo by URL. If `owner_id` exists and differs from `req.ownerId`, throw a new `RepoOwnedError`. If `owner_id` is null, claim it.
- [ ] **1.2** Add `RepoOwnedError` class (similar to `PrivateRepoError`)
- [ ] **1.3** Handle `RepoOwnedError` in POST /digest route — return 403 with `{ error, code: "REPO_OWNED" }`
- [ ] **1.4** Fix API key auth in middleware — when API key matches, set `req.user` to a service account user object (id from `REPOGRAPH_SERVICE_USER_ID` env var or a hardcoded admin UUID)
- [ ] **1.5** Fix dev mode auth in middleware — when no auth configured, set `req.user` to a deterministic dev user object
- [ ] **1.6** Update `getUserDb()` — when user is the service account or dev user (no real JWT), return `getSupabase()` (service client) instead of trying to create a user-scoped client with a non-existent token
- [ ] **1.7** Add `REPOGRAPH_SERVICE_USER_ID` to config.ts and document in README
- [ ] **1.8** Frontend: handle new 403/REPO_OWNED error code in digest flow — show user-friendly message

### Phase 2: MCP Server Tenant Isolation
- [ ] **2.1** Add `REPOGRAPH_USER_TOKEN` and `SUPABASE_ANON_KEY` env var support to MCP server
- [ ] **2.2** Create `getUserSupabase()` function in MCP server — if `REPOGRAPH_USER_TOKEN` is set, return user-scoped client; otherwise fall back to service key with console warning
- [ ] **2.3** Replace all `getSupabase()` calls in MCP tool handlers with `getUserSupabase()` for Supabase queries (runtime tools, search_code, get_file, etc.)
- [ ] **2.4** In `resolveRepoId()`, use user-scoped client so RLS filters repos
- [ ] **2.5** Verify: Neo4j queries in MCP tools only run after repo is resolved via user-scoped Supabase (confirming ownership)
- [ ] **2.6** Add startup warning if using service key without user token in MCP server

### Phase 3: SyncManager Hardening & Documentation
- [ ] **3.1** Refactor `syncManager.getStatus()` to accept optional `SupabaseClient` parameter — use it for the repo query if provided, fall back to service key
- [ ] **3.2** Refactor `syncManager.getEvents()` to accept optional `SupabaseClient` parameter
- [ ] **3.3** Update route handlers in routes.ts to pass `getUserDb(req)` to getStatus/getEvents
- [ ] **3.4** Add code comment in SyncManager documenting which methods are safe to call without prior ownership verification and which are not
- [ ] **3.5** Document Neo4j tenant model: API-layer enforcement, no owner_id in graph, all Neo4j access must be preceded by RLS ownership check

## Build Order

### Phase 1: Auth & Ownership Foundation (do first — everything depends on this)
Items 1.1 through 1.8. Must be done as a unit — the ownership guard, auth fixes, and getUserDb changes are interdependent.

**Checkpoint gate:** After Phase 1, verify:
- Digest of an owned repo by a different user returns 403
- API key auth can access /repositories, /graph, etc.
- Dev mode can access all routes without errors
- Existing Supabase JWT auth still works unchanged

### Phase 2: MCP Server Tenant Isolation
Items 2.1 through 2.6. Independent of Phase 1 (MCP server is a separate package), but logically follows.

**Checkpoint gate:** After Phase 2, verify:
- MCP server with REPOGRAPH_USER_TOKEN only sees owned repos
- MCP server without token falls back to service key with warning
- All 5 runtime tools respect tenant boundary
- search_code, get_file, get_symbol respect tenant boundary

### Phase 3: SyncManager Hardening & Documentation
Items 3.1 through 3.5. Depends on Phase 1 (needs getUserDb changes).

**Checkpoint gate:** After Phase 3, verify:
- syncManager.getStatus/getEvents use user-scoped client when called from routes
- No regression in sync status/events API responses
- Documentation accurately describes the tenant model
