# Phase 1 Dependency Audit
**Phase:** Auth & Ownership Foundation
**Date:** 2026-03-07
**Status:** PASS

## Verified Connections

| Item | Status | Key Verification |
|------|--------|-----------------|
| 1.1 Ownership guard in `runDigest()` | PASS | `digest.ts:186-195` — queries repo by URL, compares `owner_id`, throws `RepoOwnedError` on conflict, claims unowned repos |
| 1.2 `RepoOwnedError` class | PASS | `cloner.ts:19-24` — extends Error, exported, matches `PrivateRepoError` pattern |
| 1.3 Route error handling | PASS | `routes.ts:6,143-144` — imports with named import, catches with `instanceof`, returns `403 { code: "REPO_OWNED" }` |
| 1.4 API key auth user | PASS | `index.ts:46-57` — `satisfies AuthenticatedUser`, sets `accessToken: "__service__"` |
| 1.5 Dev mode auth user | PASS | `index.ts:83-93` — `satisfies AuthenticatedUser`, sets `accessToken: "__dev__"`, deterministic UUID |
| 1.6 `getUserDb()` synthetic tokens | PASS | `supabase.ts:39-58` — `SYNTHETIC_TOKENS = new Set(["__service__", "__dev__"])` matches both token strings exactly; returns `getSupabase()` for synthetic, `createUserClient()` for real JWTs |
| 1.7 `REPOGRAPH_SERVICE_USER_ID` | PASS | `config.ts:29` — reads env var, `index.ts:48` falls back to hardcoded UUID |
| 1.8 Frontend REPO_OWNED | PASS | `api.ts:158-159` attaches `err.code = data.code`; `DashboardView.tsx:342-343` extracts code; render at line 421 matches `"REPO_OWNED"` exactly |

## Stubs & Placeholders Found
None.

## Broken Chains
None.

## Missing Configuration
None — `REPOGRAPH_SERVICE_USER_ID` has a fallback default.

## Minor Observations (non-blocking)
1. **`handleReDigest` missing error code extraction** — `DashboardView.tsx:376` does not extract `err.code` like `handleDigest` does, so REPO_OWNED errors during re-digest show a generic message instead of the styled UI. The raw error message is still displayed.
2. **Ownership guard is no-op when `ownerId` is undefined** — By design for webhooks/service-key paths, but worth documenting.

## Summary
Phase 1 is complete and correctly wired. All 8 checklist items pass verification. The ownership guard, auth middleware fixes, getUserDb synthetic token detection, and frontend error handling form a coherent chain with no gaps. One minor UX issue: the re-digest path doesn't show the styled REPO_OWNED error. No blocking issues.
