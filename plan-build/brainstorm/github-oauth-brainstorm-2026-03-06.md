# Brainstorm: GitHub OAuth Login

**Created:** 2026-03-06
**Status:** Draft

## Vision

Add GitHub OAuth login as a full gate — unauthenticated users see only a login
page. Backend handles the token exchange (client secret stays server-side).
Anyone with a GitHub account can access the app.

## Existing Context

**Backend (Express):**
- Stateless API key auth via `Authorization: Bearer <token>` header
- No sessions, no cookies, no user table
- CORS configured, routes in `routes.ts`
- Supabase for data storage (repositories, jobs, sync_events, file_contents)
- Environment: `API_KEY`, `CORS_ORIGINS`, `GITHUB_TOKEN`, etc.

**Frontend (React + react-router):**
- BrowserRouter with AppShell + Sidebar layout
- Routes: /dashboard, /explore, /activity, /settings
- API calls use `authHeaders()` which sends `Authorization: Bearer <VITE_API_KEY>`
- Deployed on Vercel, backend on Railway

**GitHub OAuth App registered:**
- Homepage URL: https://repograph-one.vercel.app/dashboard
- Callback URL: https://repograph-one.vercel.app/api/auth/callback
  (Note: this hits Vercel, not the backend. Need to either proxy or use backend URL)

## Components Identified

### 1. OAuth Routes (backend, new)
- **Responsibility**: Handle GitHub OAuth flow — initiate, callback, session, logout
- **Upstream**: Frontend redirects user to GitHub; GitHub redirects back with code
- **Downstream**: Sets httpOnly cookie with JWT; returns user info via /api/auth/me
- **External dependencies**: GitHub OAuth API (authorize URL, token exchange, user API)
- **Hands test**: PASS — GitHub OAuth API is standard, needs GITHUB_CLIENT_ID and
  GITHUB_CLIENT_SECRET env vars

### 2. Auth Middleware (backend, refactor)
- **Responsibility**: Replace/augment API key auth with session-based auth
- **Upstream**: Cookie sent with every request
- **Downstream**: Attaches user info to request, allows/denies access
- **External dependencies**: JWT signing (jsonwebtoken or jose)
- **Hands test**: PARTIAL — Need SESSION_SECRET env var for JWT signing.
  Also need cookie-parser middleware.

### 3. LoginPage (frontend, new)
- **Responsibility**: Full-screen login page with "Sign in with GitHub" button
- **Upstream**: Shown when user is not authenticated
- **Downstream**: Redirects browser to GitHub authorize URL
- **External dependencies**: Needs GITHUB_CLIENT_ID to construct authorize URL
- **Hands test**: PASS — just a redirect, no server call needed

### 4. AuthProvider (frontend, new)
- **Responsibility**: React context that tracks auth state (loading/authenticated/unauthenticated)
- **Upstream**: Calls /api/auth/me on mount to check session
- **Downstream**: Provides user info and auth state to entire app
- **External dependencies**: Backend /api/auth/me endpoint
- **Hands test**: PASS

### 5. ProtectedRoute (frontend, new)
- **Responsibility**: Wrapper that redirects to login if not authenticated
- **Upstream**: AuthProvider provides auth state
- **Downstream**: Renders child route or redirects to /login
- **External dependencies**: None
- **Hands test**: PASS

### 6. Sidebar User Section (frontend, modify)
- **Responsibility**: Show logged-in user avatar + name, logout button
- **Upstream**: AuthProvider provides user info
- **Downstream**: Logout calls /api/auth/logout then clears state
- **External dependencies**: None
- **Hands test**: PASS

## Rough Dependency Map

```
GitHub OAuth App
  ├─ GITHUB_CLIENT_ID → Frontend (login redirect URL)
  ├─ GITHUB_CLIENT_ID → Backend (token exchange)
  └─ GITHUB_CLIENT_SECRET → Backend only (token exchange)

Frontend:
  main.tsx → AuthProvider
    ├─ /login → LoginPage (unauthenticated only)
    └─ AppShell (ProtectedRoute wrapper)
         ├─ Sidebar (shows user avatar, logout)
         └─ /dashboard, /explore, etc.

Backend:
  /api/auth/github → redirect to GitHub authorize
  /api/auth/callback → exchange code → set JWT cookie → redirect to frontend
  /api/auth/me → return user info from JWT
  /api/auth/logout → clear cookie
  Auth middleware → verify JWT cookie on all /api/* routes (except auth routes + health)
```

## Open Questions

1. **Callback URL routing**: The OAuth app has callback URL at
   `https://repograph-one.vercel.app/api/auth/callback` — but the backend is on
   Railway, not Vercel. Options:
   - (a) Change callback URL to Railway backend URL
   - (b) Set callback to frontend URL and have frontend forward code to backend
   - (c) Proxy /api/* from Vercel to Railway
   Option (a) is simplest and most secure.

2. **JWT vs server-side sessions**: JWT in httpOnly cookie is stateless (no session
   store needed) but can't be revoked without a blocklist. For this app, JWT is fine
   — no need for revocation.

3. **Cookie domain**: Backend is on Railway (different domain than Vercel frontend).
   Cross-origin cookies require `SameSite=None; Secure`. Or we could proxy API calls
   through Vercel to keep same origin.

4. **Dual auth**: Should we keep API key auth alongside OAuth? API key is useful for
   programmatic access (MCP, CI). OAuth is for browser users. Both should work.

## Risks and Concerns

- **Cross-origin cookies**: Frontend (Vercel) and backend (Railway) are on different
  domains. Setting cookies from the backend that are sent on frontend API calls
  requires careful CORS + cookie config. This is the trickiest part.

- **Callback URL must be the backend**: GitHub redirects to this URL with the auth
  code. If it's the frontend URL, we'd need to forward the code, adding complexity.
  Using the backend URL directly is cleaner.

- **Environment variables**: Need to add GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
  SESSION_SECRET to Railway. GITHUB_CLIENT_ID also needed as VITE_GITHUB_CLIENT_ID
  on Vercel for the frontend login redirect.
