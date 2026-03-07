# Phase 1 Forward Plan Review
**Phase completed:** Auth & Ownership Foundation
**Date:** 2026-03-07
**Plan updates needed:** NO

## Actual Interfaces Built

**`getUserDb(req)` in `packages/backend/src/db/supabase.ts:48`:**
- Throws `Error("Authentication required")` if no `req.user`.
- If `user.accessToken` is in `SYNTHETIC_TOKENS` (`"__service__"` or `"__dev__"`), returns the service-role client.
- Otherwise creates a user-scoped client via `createUserClient(user.accessToken)`.
- `SYNTHETIC_TOKENS` is private to the module (not exported).

**`AuthenticatedUser` in `packages/backend/src/auth.ts:6`:**
- Shape: `{ id, login, name, avatarUrl, githubId, accessToken }`.
- Three variants set by middleware: API key (`accessToken: "__service__"`, id from `serviceUserId` or fallback `00000000-0000-0000-0000-000000000001`), dev mode (`accessToken: "__dev__"`, id `00000000-0000-0000-0000-000000000000`), and JWT user (real token and Supabase user id).

**`RepoOwnedError` in `packages/backend/src/pipeline/cloner.ts:19`:**
- `constructor(url: string)` — message: `Repository "${url}" is owned by another user.`
- Handled in `routes.ts:143-144` as `403 { error, code: "REPO_OWNED" }`.

**`config.serviceUserId` in `packages/backend/src/config.ts:29`:**
- Env var: `REPOGRAPH_SERVICE_USER_ID`, default: `""`.

**Ownership guard in `packages/backend/src/pipeline/digest.ts:187-195`:**
- Uses service-role client for the check (correct — must see all repos to detect conflicts).
- Throws `RepoOwnedError` if `existingRepo.owner_id` exists and differs from `req.ownerId`.
- Claims unowned repos when `owner_id` is null and `ownerId` is provided.

**Frontend in `packages/frontend/src/views/DashboardView.tsx:421-428`:**
- Checks `errorCode === "REPO_OWNED"` and displays "Repository Unavailable".
- `api.ts:158-160` attaches `data.code` to thrown Error.

## Mismatches with Plan

None found. All interfaces match what Phase 2 and Phase 3 expect.

## Hook Points for Next Phase

### Phase 2: MCP Server Tenant Isolation
- `SUPABASE_ANON_KEY` already exists in backend config (line 20). MCP server will add its own read — no naming conflict.
- MCP server shares zero code with backend. `getUserSupabase()` must replicate the `createClient(url, anonKey, { headers })` pattern independently.
- `resolveRepoId(sb: SupabaseClient, repoNameOrUrl: string)` in `packages/mcp-server/src/repo-resolver.ts` already accepts a `SupabaseClient` as first argument. Phase 2 just swaps `getSupabase()` for `getUserSupabase()` at call sites.
- `registerRuntimeTools` and `registerTemporalTools` accept `getSupabase` via dependency injection (`GetSupabaseFn` type). Phase 2 can swap the injected function at registration without changing handler code.

### Phase 3: SyncManager Hardening
- `syncManager.getStatus(repoId)` and `syncManager.getEvents(repoId, limit)` currently use service-role client internally. Adding an optional `SupabaseClient` parameter is additive and backward-compatible.
- Routes already do RLS ownership checks before calling these methods.
- `getUserDb(req)` with synthetic token users returns the service-role client, so passing it to SyncManager is functionally identical to current behavior.

## Risks and Warnings

1. **RISK: `sync_events` RLS policy unverified.** Phase 3 will pass user-scoped clients to `getEvents()` which queries `sync_events`. If that table lacks an RLS read policy for owned repos, results will be empty. Verify RLS policies before Phase 3.
2. **RISK: `ownerId` is optional in `DigestRequest`.** When undefined (webhook-triggered), the ownership guard short-circuits. Webhook digests can re-digest any repo. The plan accepts this.
3. **NOTE: Dev mode activates only when `!config.apiKey && !config.supabase.anonKey`.** If `SUPABASE_ANON_KEY` is set without `API_KEY`, dev mode won't trigger.
4. **NOTE: Dual ownership checks after Phase 3.** Routes will do an RLS check then pass user-scoped client to SyncManager (another RLS check). This is defense-in-depth, not a bug.

## Verdict

Phase 1 is complete and correctly wired. No blocking mismatches for Phase 2 or Phase 3. Both can proceed — Phase 2 independently, Phase 3 after Phase 1 stabilizes.
