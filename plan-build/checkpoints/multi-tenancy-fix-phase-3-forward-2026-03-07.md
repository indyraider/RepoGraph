# Phase 3 Forward Plan Review
**Phase completed:** SyncManager Hardening & Documentation
**Date:** 2026-03-07
**Plan updates needed:** NO

## Actual Interfaces Built

**`packages/backend/src/sync/manager.ts`:**
- `getStatus(repoId: string, sb?: SupabaseClient)` — optional user-scoped client, falls back to `getSupabase()`
- `getEvents(repoId: string, limit = 20, sb?: SupabaseClient)` — optional user-scoped client, falls back to `getSupabase()`
- `trigger()` — documented: caller MUST verify ownership, uses service-role internally
- `updateMode()` — documented: caller MUST verify ownership, uses service-role internally

**`packages/backend/src/routes.ts` (Phase 3 changes):**
- `GET /repos/:id/sync/status` — passes `getUserDb(req)` to `syncManager.getStatus(repoId, sb)`
- `GET /repos/:id/sync/events` — passes `getUserDb(req)` to `syncManager.getEvents(repoId, undefined, sb)`

**`packages/backend/src/db/neo4j.ts`:**
- Top-of-file documentation: Neo4j has no per-user isolation, data keyed by `repo_url`, tenant boundaries enforced at API layer via Supabase RLS, MCP scopes to `SCOPED_REPO`

## Complete Multi-Tenancy Summary

| Layer | Mechanism | Coverage |
|-------|-----------|----------|
| **Supabase RLS** | Row-level security filtered by `owner_id` matching JWT user | All Supabase-backed reads by authenticated users |
| **API-layer guards** | Auth middleware, `getUserDb()`, ownership guard in `runDigest()` | All backend API routes |
| **Neo4j scoping** | No native isolation; gated behind Supabase RLS check first | All graph queries |

**Auth modes:**
- **Supabase JWT:** Full RLS via user-scoped client
- **API key:** Service-role client, `REPOGRAPH_SERVICE_USER_ID` tracks ownership
- **Dev mode:** Service-role client, only when no auth configured
- **MCP server:** User-scoped if `REPOGRAPH_USER_TOKEN` + `SUPABASE_ANON_KEY` set; service-key fallback with warning

**Env vars introduced across all phases:**
- `REPOGRAPH_SERVICE_USER_ID` — UUID for API-key-created resources
- `REPOGRAPH_USER_TOKEN` — MCP server per-user Supabase access token
- `SUPABASE_ANON_KEY` — required for user-scoped clients

## Remaining Gaps or Loose Ends

1. **No README docs for new env vars** — `REPOGRAPH_SERVICE_USER_ID`, `REPOGRAPH_USER_TOKEN` should be documented. Non-blocking.
2. **Webhook handler uses service key** — `POST /api/webhooks/github` is signature-validated, accepted risk per plan.
3. **`getEvents` parameter ergonomics** — callers must pass `undefined` for `limit` to reach `sb`. Style issue, not a bug.

## Verdict

All three phases form a coherent, complete multi-tenancy solution. No code mismatches or security gaps remain. Every contract is implemented and wired correctly. Phase 3 is the final phase — the plan is fully executed.
