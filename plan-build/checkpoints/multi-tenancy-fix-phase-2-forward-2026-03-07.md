# Forward Checkpoint: Multi-Tenancy Fix — Phase 2 Complete

**Date:** 2026-03-07
**Phase completed:** Phase 2 — MCP Server Tenant Isolation (items 2.1-2.6)
**Remaining:** Phase 3 — SyncManager Hardening & Documentation (items 3.1-3.5)

---

## Interface Extraction (Phase 2 Actual)

### `getUserSupabase()` — lines 54-69 of `packages/mcp-server/src/index.ts`

```
function getUserSupabase(): SupabaseClient
```

- **Behavior:** If `REPOGRAPH_USER_TOKEN` is set AND `SUPABASE_ANON_KEY` is set, returns a user-scoped client (anon key + Bearer token). Otherwise falls back to `getSupabase()` (service key).
- **Caching:** Module-level `let userSupabase: SupabaseClient | null = null` — singleton, created once.
- **Fallback path 1:** `USER_TOKEN` is falsy -> returns `getSupabase()` immediately (line 55).
- **Fallback path 2:** `USER_TOKEN` set but `SUPABASE_ANON_KEY` empty -> logs error, returns `getSupabase()` (line 59-60).
- **No exceptions thrown** — always returns a valid client.

### Env Var Reads

| Variable | Read at | Default |
|---|---|---|
| `REPOGRAPH_USER_TOKEN` | Module-level `const USER_TOKEN = process.env.REPOGRAPH_USER_TOKEN \|\| null` (line 52) | `null` |
| `SUPABASE_ANON_KEY` | Inside `getUserSupabase()` on first call (line 57) | `""` |

### DI Injection to Sub-Modules

Both registration calls pass `getUserSupabase` (the function reference, not a call result):

```
registerRuntimeTools(server, getSession, getUserSupabase, SCOPED_REPO);   // line 1128
registerTemporalTools(server, getSession, getUserSupabase, SCOPED_REPO);  // line 1131
```

The sub-modules define the DI parameter as `getSupabase: () => SupabaseClient` and call it as `const sb = getSupabase()` within each tool handler. This is correct — every tool invocation gets the user-scoped client.

### `resolveRepoId()` (repo-resolver.ts)

Accepts `sb: SupabaseClient` as its first parameter. Callers in `runtime-tools.ts` pass `getSupabase()` (which is the injected `getUserSupabase`). This means RLS is enforced during repo resolution — a user can only resolve repos they own. Confirmed correct (item 2.4).

### `getScopedRepoId()` (index.ts line 77-89)

Also uses `getUserSupabase()` (line 80), so scoped repo lookup is RLS-filtered. Correct.

### Startup Warning (lines 1154-1158)

```
if (USER_TOKEN) {
  console.error("RepoGraph MCP: user token set — queries scoped to user's repos via RLS");
} else {
  console.error("RepoGraph MCP: WARNING — no REPOGRAPH_USER_TOKEN set, using service key (all tenants visible)");
}
```

Present and correct (item 2.6).

### Startup Health Check (line 1146)

Uses `getSupabase()` (service key) for the connection check, not `getUserSupabase()`. This is intentional — the health check should work regardless of user token validity.

---

## Remaining `getSupabase()` Calls in MCP Server

One remaining `getSupabase()` call at line 1146 (startup health check). All tool-handler paths use `getUserSupabase()`. No leaks detected.

---

## Mismatch Detection: Phase 2 vs. Phase 3

### Cross-Package Boundary

Phase 2 modified `packages/mcp-server/src/index.ts`. Phase 3 targets `packages/backend/src/sync/manager.ts` and `packages/backend/src/routes.ts`. These are **separate packages with no shared code**. No direct interface dependency between Phase 2 output and Phase 3 input.

### Pattern Consistency Check

Both packages now follow the same pattern for user-scoped Supabase clients:

| Package | Service client | User-scoped client | Creation pattern |
|---|---|---|---|
| **backend** (`db/supabase.ts`) | `getSupabase()` | `getUserDb(req)` → checks synthetic tokens → `createUserClient(accessToken)` | Per-request, from JWT |
| **mcp-server** (`index.ts`) | `getSupabase()` | `getUserSupabase()` → checks `USER_TOKEN` env var | Singleton, from env var |

The patterns differ (per-request vs singleton) but this is appropriate — the MCP server runs as a single-user process, while the backend serves multiple users concurrently.

**No inconsistency found.**

---

## Dependency Readiness for Phase 3

### What Phase 3 Needs from Phase 1

Phase 3 depends on **Phase 1's `getUserDb(req)`** function, which is already built and working:

- `getUserDb(req)` at `packages/backend/src/db/supabase.ts:48` — returns user-scoped `SupabaseClient`.
- Handles synthetic tokens (`__service__`, `__dev__`) by returning service client.
- Already imported and used in `routes.ts` (line 2) and in the sync status/events routes (lines 308, 335).

### Phase 3 Items — Readiness Assessment

| Item | What It Needs | Status |
|---|---|---|
| **3.1** Refactor `getStatus()` to accept optional `SupabaseClient` | `getStatus(repoId)` currently calls `getSupabase()` (line 222). Needs signature change to `getStatus(repoId, sb?: SupabaseClient)`. No blockers. | Ready |
| **3.2** Refactor `getEvents()` to accept optional `SupabaseClient` | `getEvents(repoId, limit)` currently calls `getSupabase()` (line 245). Needs signature change to `getEvents(repoId, limit, sb?: SupabaseClient)`. No blockers. | Ready |
| **3.3** Update route handlers to pass `getUserDb(req)` | Routes at lines 306-330 and 332-354 already call `getUserDb(req)` for ownership verification. The `sb` variable is already in scope. Just need to pass it: `syncManager.getStatus(repoId, sb)` and `syncManager.getEvents(repoId, sb)`. No blockers. | Ready |
| **3.4** Add code comments documenting safety model | Documentation task only. No blockers. | Ready |
| **3.5** Document Neo4j tenant model | Documentation task only. No blockers. | Ready |

### Observation: Route Handlers Already Do Ownership Checks

Both sync routes (`/repos/:id/sync/status` and `/repos/:id/sync/events`) already:
1. Call `getUserDb(req)` to get a user-scoped client
2. Query `repositories` with RLS to verify the user owns the repo
3. Return 404 if the repo is not found (RLS filters it out)

This means even without Phase 3's refactor, the routes are **already tenant-safe** via the pre-check. Phase 3's refactor (passing the user-scoped client into `getStatus`/`getEvents`) adds defense-in-depth: the SyncManager's own Supabase queries would also be RLS-filtered, rather than using the service key.

The practical security improvement is marginal since the route already gates on ownership, but it's good hygiene and prevents future regressions if someone adds a new call site that forgets the pre-check.

---

## Risks and Flags

1. **None blocking.** Phase 3 has no dependency on Phase 2 output. All dependencies come from Phase 1, which is complete.

2. **Parameter ordering caution for item 3.2:** `getEvents` currently has signature `getEvents(repoId: string, limit = 20)`. Adding an optional `sb` as a third parameter works cleanly: `getEvents(repoId: string, limit?: number, sb?: SupabaseClient)`. However, if the plan intended `getEvents(repoId, sb?)`, that would conflict with the existing `limit` parameter. Recommend keeping limit as the second param and adding `sb` as third.

3. **`updateMode` and `executeDigest` also use `getSupabase()` directly** (lines 76, 191). The plan explicitly says to keep service key for write paths. Confirm this is intentional and add a code comment per item 3.4.

---

## Verdict

**Phase 2 is complete and correct. Phase 3 is fully unblocked.** No interface mismatches detected. All dependencies from Phase 1 are in place. Proceed with Phase 3.
