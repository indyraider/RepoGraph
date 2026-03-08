/**
 * Error Pattern Library — recognizes common error signatures in stack traces
 * and log messages, providing resolution hints to speed up debugging.
 */

export interface ErrorPattern {
  id: string;
  name: string;
  /** Regex tested against the full raw stack / log message */
  match: RegExp;
  /** Short category tag */
  category: "auth" | "config" | "network" | "runtime" | "build" | "database";
  /** Human-readable explanation of what likely went wrong */
  explanation: string;
  /** Concrete resolution steps */
  resolution: string[];
}

export const ERROR_PATTERNS: ErrorPattern[] = [
  {
    id: "supabase-jwt-as-github-token",
    name: "Supabase JWT used as GitHub token",
    match: /https:\/\/eyJ[\w.]+@github\.com/,
    category: "auth",
    explanation: "A Supabase JWT (session access token) is being used where a GitHub OAuth token is expected. The clone URL contains a base64-encoded JWT instead of a GitHub PAT.",
    resolution: [
      "Check that the frontend sends the GitHub provider_token via X-GitHub-Token header, not the Supabase access_token",
      "Verify that session.provider_token is captured on SIGNED_IN and persisted (it's only available once)",
      "Check that the backend reads req.headers['x-github-token'], not req.user.accessToken",
    ],
  },
  {
    id: "git-auth-failure",
    name: "Git clone authentication failure",
    match: /fatal: (?:could not read (?:Username|Password)|Authentication failed|repository .+ not found)/i,
    category: "auth",
    explanation: "Git clone failed due to missing or invalid credentials. The repository may be private and the token is missing, expired, or wrong type.",
    resolution: [
      "Verify the GitHub token is a valid PAT or OAuth token (not a JWT or API key)",
      "Check that the token has 'repo' scope for private repos",
      "Check config.githubToken (GITHUB_TOKEN env var) fallback is set correctly",
    ],
  },
  {
    id: "cors-error",
    name: "CORS policy violation",
    match: /has been blocked by CORS policy|Access-Control-Allow-Origin/,
    category: "network",
    explanation: "The browser blocked a cross-origin request because the server didn't include proper CORS headers.",
    resolution: [
      "Add the frontend origin to the backend's CORS allowed origins list",
      "Ensure preflight OPTIONS requests are handled",
      "Check that credentials mode matches Access-Control-Allow-Credentials",
    ],
  },
  {
    id: "econnrefused",
    name: "Connection refused",
    match: /ECONNREFUSED|connect ECONNREFUSED/,
    category: "network",
    explanation: "The backend tried to connect to a service (database, Redis, external API) that isn't running or isn't reachable.",
    resolution: [
      "Check that the target service is running and accepting connections",
      "Verify the connection URL/host/port in environment variables",
      "Check network policies and firewall rules in the deployment environment",
    ],
  },
  {
    id: "neo4j-connection",
    name: "Neo4j connection failure",
    match: /Neo4j|ServiceUnavailable.*bolt|failed to connect.*7687/i,
    category: "database",
    explanation: "Cannot connect to the Neo4j graph database. The database may be down, or the connection URI/credentials are wrong.",
    resolution: [
      "Check NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD environment variables",
      "Verify the Neo4j instance is running (check Aura dashboard or docker status)",
      "Check if the connection pool is exhausted (too many open sessions)",
    ],
  },
  {
    id: "supabase-rls",
    name: "Supabase RLS policy violation",
    match: /new row violates row-level security|permission denied for table/,
    category: "database",
    explanation: "A database operation was blocked by Row Level Security policies. The user's JWT may not have the required permissions.",
    resolution: [
      "Check that the Supabase client is using the correct token (service key for backend, user JWT for frontend)",
      "Verify RLS policies on the affected table allow the operation for this user role",
      "Check that owner_id matches auth.uid() in the RLS policy",
    ],
  },
  {
    id: "module-not-found",
    name: "Module not found",
    match: /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/,
    category: "build",
    explanation: "A required module or file import could not be resolved at runtime.",
    resolution: [
      "Check that the module is listed in package.json dependencies (not just devDependencies)",
      "Run 'npm install' or 'npm ci' to ensure all dependencies are installed",
      "For local imports, verify the file path and .js extension (ESM requires explicit extensions)",
    ],
  },
  {
    id: "sigterm",
    name: "Process killed (SIGTERM)",
    match: /signal SIGTERM|Lifecycle script .+ failed.*SIGTERM/,
    category: "runtime",
    explanation: "The process was killed by SIGTERM, typically by the deployment platform due to a crash, OOM, or health check timeout.",
    resolution: [
      "Check for unhandled exceptions or promise rejections that crash the process",
      "Monitor memory usage — the process may be exceeding the container memory limit",
      "Increase the health check timeout or startup grace period in the deployment config",
    ],
  },
  {
    id: "scip-parse-invalid-arg",
    name: "SCIP parse failure (Invalid argument)",
    match: /Parse skipped .+ \(\w+\): Invalid argument/,
    category: "build",
    explanation: "The SCIP TypeScript indexer failed to parse one or more files. This usually means the file uses syntax not supported by the bundled TypeScript version.",
    resolution: [
      "Check if the file uses very new TypeScript syntax (e.g., satisfies, const type params)",
      "Try updating the scip-typescript version in the backend",
      "These files will be skipped in the graph — symbols from them won't have type info",
    ],
  },
  {
    id: "rate-limit",
    name: "Rate limit exceeded",
    match: /rate limit|429|too many requests/i,
    category: "network",
    explanation: "An external API (GitHub, Vercel, Railway) returned a rate limit error.",
    resolution: [
      "Wait for the rate limit window to reset (check Retry-After header)",
      "Reduce polling frequency for log sources",
      "Use authenticated requests for higher rate limits (especially GitHub API)",
    ],
  },
];

/**
 * Match raw error text against known patterns and return all matches.
 */
export function matchErrorPatterns(rawText: string): ErrorPattern[] {
  return ERROR_PATTERNS.filter((p) => p.match.test(rawText));
}

/**
 * Format matched patterns as markdown for inclusion in trace_error output.
 */
export function formatPatternMatches(patterns: ErrorPattern[]): string {
  if (patterns.length === 0) return "";

  let output = "### Known Error Patterns Matched\n\n";
  for (const p of patterns) {
    output += `**${p.name}** (\`${p.category}\`)\n`;
    output += `${p.explanation}\n\n`;
    output += `**Resolution:**\n`;
    for (const step of p.resolution) {
      output += `- ${step}\n`;
    }
    output += "\n";
  }
  return output;
}
