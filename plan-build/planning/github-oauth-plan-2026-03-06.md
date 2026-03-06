# Build Plan: GitHub OAuth Login

**Created:** 2026-03-06
**Brainstorm:** ../brainstorm/github-oauth-brainstorm-2026-03-06.md
**Status:** Executing

## Overview

Add GitHub OAuth as a login gate. Unauthenticated users see a login page only.
Backend handles token exchange (client secret server-side), sets an httpOnly JWT
cookie. Frontend wraps all routes in a protected route that checks auth state.
API key auth is preserved for programmatic/MCP access alongside cookie auth.

Backend: https://repograph-api-production.up.railway.app
Frontend: https://repograph-one.vercel.app
GitHub OAuth callback: https://repograph-api-production.up.railway.app/api/auth/callback

## Integration Contracts

### GitHub → Backend /api/auth/callback
- **What flows**: GET request with `?code=<auth_code>` query param
- **How**: GitHub redirects user's browser after authorization
- **Auth**: None (public endpoint)
- **Error path**: Redirect to frontend /login?error=auth_failed

### Backend /api/auth/callback → GitHub API
- **What flows**: POST to https://github.com/login/oauth/access_token
  with {client_id, client_secret, code}
- **How**: Server-side fetch
- **Auth**: GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET
- **Error path**: Redirect to frontend /login?error=auth_failed

### Backend /api/auth/callback → GitHub API (user info)
- **What flows**: GET https://api.github.com/user with access_token
- **How**: Server-side fetch, Authorization: Bearer <access_token>
- **Auth**: OAuth access token
- **Error path**: Redirect to frontend /login?error=auth_failed

### Backend → Frontend (cookie)
- **What flows**: httpOnly JWT cookie containing {githubId, login, name, avatarUrl}
- **How**: Set-Cookie header on /api/auth/callback response, then 302 redirect to frontend
- **Cookie config**: httpOnly, Secure, SameSite=None (cross-origin), Path=/
- **Error path**: Cookie not set → frontend detects unauthenticated

### Frontend → Backend (every API call)
- **What flows**: Cookie sent automatically via credentials: "include"
- **How**: All fetch() calls add `credentials: "include"` option
- **Auth**: JWT cookie verified by backend middleware
- **Error path**: 401 → frontend redirects to /login

### Frontend /api/auth/me → Backend
- **What flows**: GET request, returns {id, login, name, avatar_url} or 401
- **How**: Frontend calls on app load to check auth state
- **Auth**: JWT cookie
- **Error path**: 401 → show login page

## End-to-End Flows

### Flow 1: Login
```
1. User visits any route (e.g., /dashboard)
2. AuthProvider calls GET /api/auth/me (with credentials: include)
3. Backend returns 401 (no cookie)
4. AuthProvider sets state to "unauthenticated"
5. ProtectedRoute redirects to /login
6. User clicks "Sign in with GitHub"
7. Browser redirects to https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...
8. User authorizes on GitHub
9. GitHub redirects to https://repograph-api-production.up.railway.app/api/auth/callback?code=...
10. Backend exchanges code for access_token via GitHub API
11. Backend fetches user profile via GitHub API
12. Backend signs JWT with {githubId, login, name, avatarUrl}
13. Backend sets httpOnly cookie and redirects to https://repograph-one.vercel.app/dashboard
14. Browser loads /dashboard, AuthProvider calls /api/auth/me
15. Backend validates JWT cookie, returns user info
16. AuthProvider sets state to "authenticated" with user data
17. Dashboard renders
```

### Flow 2: Subsequent visits (cookie exists)
```
1. User visits /dashboard
2. AuthProvider calls GET /api/auth/me (cookie sent automatically)
3. Backend validates JWT, returns user info
4. AuthProvider sets "authenticated" — app renders normally
```

### Flow 3: Logout
```
1. User clicks logout in sidebar
2. Frontend calls POST /api/auth/logout (credentials: include)
3. Backend clears cookie (Set-Cookie with maxAge=0)
4. Frontend clears auth state, redirects to /login
```

### Flow 4: API key access (programmatic)
```
1. MCP/CI sends request with Authorization: Bearer <API_KEY>
2. Backend auth middleware checks: cookie first, then API key
3. API key matches → request proceeds (no user context, just "api_key" auth)
```

## Wiring Checklist

### Backend Dependencies
- [ ] Install jsonwebtoken and cookie-parser in packages/backend
- [ ] Install @types/jsonwebtoken and @types/cookie-parser as dev deps

### Backend Config
- [ ] Add to config.ts: githubClientId, githubClientSecret, sessionSecret, frontendUrl
- [ ] Env vars needed: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET, FRONTEND_URL

### Backend Auth Routes (new file: src/auth.ts)
- [ ] GET /api/auth/github — redirect to GitHub authorize URL
- [ ] GET /api/auth/callback — exchange code, fetch user, set JWT cookie, redirect
- [ ] GET /api/auth/me — return user info from JWT cookie
- [ ] POST /api/auth/logout — clear cookie

### Backend Middleware Changes (src/index.ts)
- [ ] Add cookie-parser middleware
- [ ] Refactor auth middleware: check JWT cookie OR API key (either allows access)
- [ ] Skip auth for /api/auth/* routes (in addition to /health and /webhooks)

### Frontend Auth
- [ ] Add credentials: "include" to all fetch() calls in api.ts
- [ ] Add auth API functions: getMe(), logout()
- [ ] Create AuthProvider context (src/AuthProvider.tsx)
- [ ] Create LoginPage (src/views/LoginPage.tsx)
- [ ] Add /login route to main.tsx
- [ ] Wrap AppShell route in ProtectedRoute
- [ ] Add user avatar + logout to Sidebar bottom

### Frontend Config
- [ ] VITE_GITHUB_CLIENT_ID env var (for constructing authorize URL on login page)

### Deployment
- [ ] Add GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET, FRONTEND_URL to Railway
- [ ] Add VITE_GITHUB_CLIENT_ID to Vercel
- [ ] Update CORS_ORIGINS on Railway to include Vercel domain

## Build Order

### Phase 1: Backend Auth
Install deps, add config, create auth routes, refactor middleware, add cookie-parser.

### Phase 2: Frontend Auth
Add credentials to fetch, create AuthProvider, LoginPage, ProtectedRoute, update
Sidebar with user info, wire routes.

### Phase 3: Test & Deploy
Verify build, document env vars needed for deployment.
