# Brainstorm: Multi-Tenancy Safety Audit
**Created:** 2026-03-07
**Status:** Draft

## Vision
Full audit of every feature, route, background process, and data layer to ensure tenant isolation is enforced end-to-end. The goal is to identify every code path where one tenant's data could leak to, be modified by, or be stolen by another tenant.

## Existing Context

**Architecture:** Express backend + Supabase (Postgres with RLS) + Neo4j (graph DB) + MCP server (CLI tool).

**Auth model:**
- Supabase Auth with GitHub OAuth provider
- JWT access tokens verified by middleware, user attached to `req.user`
- API key fallback for programmatic access (MCP, scripts)
- Dev mode fallback: no auth when keys not configured

**Tenant boundary:**
- Supabase: `owner_id` column on `repositories`, `user_connections`. Child tables (digest_jobs, file_contents, sync_events, log_sources, deployments, runtime_logs) use `repo_id` FK with RLS policies that check `repo_id IN (SELECT id FROM repositories WHERE owner_id = auth.uid())`.
- Neo4j: No tenant boundary. All data scoped by `repo_url`, not `owner_id`.

**Two Supabase clients:**
- `getSupabase()` — service-role key, bypasses RLS. Used by background processes and pipeline.
- `getUserDb(req)` / `createUserClient(token)` — anon key + user JWT, RLS enforced.

## Issues Found

### CRITICAL-1: Repo Ownership Theft via Upsert

**File:** `packages/backend/src/pipeline/digest.ts:187-198`

```typescript
const repoRow = { url: req.url, name: repoName, branch: req.branch, status: "digesting" };
if (req.ownerId) repoRow.owner_id = req.ownerId;
const { data: repo } = await sb
  .from("repositories")
  .upsert(repoRow, { onConflict: "url" })
  .select("id, commit_sha")
  .single();
```

The `repositories` table has a unique constraint on `url`. If User A has already digested `https://github.com/org/repo`, and User B tries to digest the same URL, the upsert matches on `url` and **overwrites `owner_id` to User B's ID**. User A loses all access to the repository, its jobs, file contents, sync events, and logs via RLS.

**Impact:** Any authenticated user can steal any other user's repository by digesting the same URL.

**Fix:** Before upserting, check if a repo with that URL already exists with a different owner. If so, reject with 403 or create a separate repo record (requires removing the `url` unique constraint and adding a composite `(url, owner_id)` constraint).

---

### CRITICAL-2: API Key Auth Bypasses RLS (Broken)

**File:** `packages/backend/src/index.ts:46-48`

```typescript
if (token && config.apiKey && token === config.apiKey) {
  return next(); // req.user is never set
}
```

When API key auth succeeds, `req.user` is never populated. Every route that calls `getUserDb(req)` will throw `"Authentication required"`, returning a 500 error. Routes using `getUser(req)` will get `null`.

**Impact:**
- API key users cannot access any RLS-protected endpoint (repositories, jobs, graph, logs, connections).
- Digest via API key creates repos with `owner_id = null` — invisible to all users via RLS.
- The MCP server (which uses its own direct DB connections) is unaffected, but any HTTP-based programmatic access is broken.

**Fix:** Either (a) require API key users to also provide a user context (e.g., `X-User-Id` header validated against a trusted list), or (b) when API key auth succeeds, create a synthetic admin user on `req.user`, or (c) create a service-scoped Supabase client for API key requests that bypasses RLS intentionally with explicit tenant filtering.

---

### CRITICAL-3: MCP Server Has No Tenant Isolation

**File:** `packages/mcp-server/src/index.ts:39-47`

The MCP server creates a Supabase client with `SUPABASE_SERVICE_KEY`, which bypasses all RLS policies. Every MCP tool (`get_recent_logs`, `search_logs`, `get_deploy_errors`, `trace_error`, `get_file`, `search_code`, etc.) can access any tenant's data.

The `SCOPED_REPO` env var limits results to one repo, but this is a convenience feature, not a security boundary — the user sets it themselves, and the underlying queries have no tenant filter.

**Impact:** Any MCP server user with the service key can read logs, file contents, and graph data for all tenants.

**Fix:** For multi-tenant deployments, the MCP server needs per-user auth. Options:
1. Accept a user access token and create a user-scoped Supabase client
2. Accept an owner_id and add explicit `WHERE owner_id = $ownerId` filters
3. Keep service key but enforce that `SCOPED_REPO` resolves to a repo owned by the configured user

---

### HIGH-1: Neo4j Has No Tenant Isolation

**Files:** All of `packages/backend/src/pipeline/loader.ts`, `packages/mcp-server/src/index.ts`

Neo4j nodes are keyed by `repo_url`, not `owner_id`. There is no concept of tenant ownership in the graph database. The Express API routes mitigate this by verifying repo ownership via Supabase RLS before querying Neo4j, but:

1. **If CRITICAL-1 is exploited**, the attacker gets the repo URL and can query all its graph data.
2. **The MCP server** queries Neo4j directly with no ownership check.
3. **Two users cannot independently analyze the same repo URL** — they'd collide on the same Neo4j nodes.

**Impact:** Graph data is globally shared per repo URL. Ownership is enforced only at the API layer, not the data layer.

**Fix:** Add `owner_id` to Neo4j Repository nodes and propagate to all child nodes/queries. Or accept that Neo4j is a shared cache and ensure API-layer ownership checks are airtight (after fixing CRITICAL-1).

---

### HIGH-2: SyncManager Internal Service Key Usage

**File:** `packages/backend/src/sync/manager.ts`

The SyncManager uses `getSupabase()` (service key) for all operations:
- `getStatus()` (line 223) — queries repo without tenant filter
- `getEvents()` (line 246) — queries sync_events without tenant filter
- `updateMode()` (line 203) — updates repo without tenant filter
- `executeDigest()` (line 82-91) — creates sync_events without tenant filter

The Express routes that call these methods validate ownership via `getUserDb(req)` first, so current code paths are safe. But this is a **fragile pattern** — any new code path that calls `syncManager.trigger()` or `syncManager.getStatus()` directly (e.g., a new API route, a background job, a webhook) would bypass tenant checks.

**Fix:** Either pass the user-scoped Supabase client into SyncManager methods, or add explicit `owner_id` checks inside SyncManager.

---

### HIGH-3: Dev Mode Bypasses Auth But Breaks RLS Routes

**File:** `packages/backend/src/index.ts:72-75`

```typescript
if (!config.apiKey && !config.supabase.anonKey) {
  return next(); // No auth configured = dev mode
}
```

In dev mode, `req.user` is never set. All `getUserDb(req)` calls throw. This means dev mode is broken for every RLS-protected route unless the developer also provides a valid Supabase token.

**Fix:** In dev mode, either create a mock user on `req.user`, or fall back to `getSupabase()` (service key) with a warning.

---

### MEDIUM-1: Webhook Handler Repo Lookup Bypasses RLS

**File:** `packages/backend/src/sync/webhook.ts:50-55`

```typescript
const sb = getSupabase();
const { data: repos } = await sb
  .from("repositories")
  .select("id, url, branch, sync_mode, sync_config, commit_sha")
  .in("url", candidateUrls);
```

The webhook handler uses the service key to look up repos by URL. This is **by design** — webhooks arrive without user auth, and signature validation provides security. However, it means anyone who knows a repo's URL can probe whether it's registered in RepoGraph by sending a crafted webhook (they'd get a different response for registered vs. unregistered repos).

**Impact:** Information disclosure (repo existence). Low severity since webhook signature validation prevents actual action.

---

### MEDIUM-2: connections.ts Upsert Uses Service Key

**File:** `packages/backend/src/connections.ts:118-133`

The PUT route uses `getSupabase()` (service key) for the upsert, setting `owner_id: user.id`. This is functionally correct — the authenticated user's ID is used — but it bypasses RLS for the write operation. The `onConflict: "github_id,provider,label"` constraint prevents cross-tenant collisions as long as `github_id` is unique per user.

**Impact:** Low risk currently. Would become a problem if the conflict key changes.

---

### LOW-1: Background Processes Use Service Key (Acceptable)

**Files:**
- `packages/backend/src/runtime/collector.ts` — Polls all enabled log sources
- `packages/backend/src/runtime/retention.ts` — Prunes old logs globally
- `packages/backend/src/sync/watcher.ts:121-158` — Restarts watchers for all repos
- `packages/backend/src/index.ts:135-160` — Job timeout checker

These all use `getSupabase()` (service key) to operate across all tenants. This is correct for admin/background operations. No fix needed, but document the pattern.

---

## Component Inventory

### Components with GOOD tenant isolation:
| Component | File | Method |
|-----------|------|--------|
| GET /repositories | routes.ts:156 | `getUserDb(req)` → RLS |
| GET /jobs/:id | routes.ts:171 | `getUserDb(req)` → RLS |
| GET /repositories/:id/jobs | routes.ts:187 | `getUserDb(req)` → RLS |
| DELETE /repositories/:id | routes.ts:203 | `getUserDb(req)` → RLS |
| GET /graph/:repoId | routes.ts:354 | `getUserDb(req)` → RLS, then Neo4j by url |
| GET /graph/:repoId/file-content | routes.ts:420 | `getUserDb(req)` → RLS |
| PUT /repos/:id/sync | routes.ts:238 | `getUserDb(req)` → RLS check first |
| GET /repos/:id/sync/status | routes.ts:302 | `getUserDb(req)` → RLS check first |
| GET /repos/:id/sync/events | routes.ts:329 | `getUserDb(req)` → RLS check first |
| GET /connections | connections.ts:18 | `createUserClient()` → RLS |
| GET /connections/mcp-config | connections.ts:51 | `createUserClient()` → RLS |
| DELETE /connections/:provider | connections.ts:144 | `createUserClient()` → RLS |
| All log source routes | runtime/routes.ts | `getUserDb(req)` → RLS |
| All runtime log routes | runtime/log-routes.ts | `getUserDb(req)` → RLS |

### Components with BROKEN/MISSING tenant isolation:
| Component | File | Issue |
|-----------|------|-------|
| POST /digest (upsert) | digest.ts:192 | CRITICAL-1: Ownership theft |
| API key auth middleware | index.ts:46 | CRITICAL-2: No user context |
| MCP server (all tools) | mcp-server/index.ts | CRITICAL-3: Service key, no tenant |
| Neo4j graph data | loader.ts (all) | HIGH-1: No owner_id in graph |
| SyncManager internals | sync/manager.ts | HIGH-2: Service key, fragile pattern |
| Dev mode auth bypass | index.ts:72 | HIGH-3: Breaks RLS routes |
| Webhook repo lookup | sync/webhook.ts:50 | MEDIUM-1: Info disclosure |
| Connection upsert | connections.ts:118 | MEDIUM-2: Service key write |

## Rough Dependency Map

```
Frontend (Supabase JWT)
  → Express Auth Middleware (verifies JWT, sets req.user)
    → Route handlers (getUserDb → RLS-scoped queries)
      → Supabase (RLS enforced by user JWT)
      → Neo4j (NO tenant isolation, scoped by repo_url)

API Key Auth
  → Express Auth Middleware (skips user setup) ← BROKEN
    → Route handlers (getUserDb throws) ← FAILS

MCP Server (service key)
  → Supabase (RLS BYPASSED) ← NO TENANT ISOLATION
  → Neo4j (NO tenant isolation)

Background Processes (service key)
  → Supabase (RLS BYPASSED, intentional)

Digest Pipeline (service key)
  → Supabase repo upsert (OWNERSHIP THEFT risk)
  → Neo4j loader (no tenant boundary)
```

## Open Questions

1. **Should the same repo URL be sharable across tenants?** If yes, need composite key `(url, owner_id)` on repositories. If no, the current unique `url` constraint is fine but ownership must be protected.
2. **Is the MCP server intended for multi-tenant use?** If single-user only, the service key is fine. If multi-tenant, needs per-user auth.
3. **What should API key auth unlock?** Admin-level access (all tenants)? Or should it require pairing with a user identity?
4. **Should Neo4j get owner_id?** Or is API-layer enforcement sufficient?

## Risks and Concerns

1. **CRITICAL-1 is exploitable today** — any authenticated user can steal repos
2. **CRITICAL-2 means programmatic access is broken** for RLS-protected routes
3. **The SyncManager fragile pattern** will bite on the next feature addition
4. **Neo4j as a shared namespace** means multi-tenant graph isolation requires architectural work
