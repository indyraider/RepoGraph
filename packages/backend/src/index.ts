import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { verifyNeo4jConnection, initNeo4jIndexes, closeNeo4j } from "./db/neo4j.js";
import { verifySupabaseConnection, getSupabase } from "./db/supabase.js";
import { restartWatchers, stopAllWatchers } from "./sync/watcher.js";
import routes from "./routes.js";
import authRoutes, { type AuthenticatedUser } from "./auth.js";
import connectionRoutes from "./connections.js";
import { startCollector, stopCollector } from "./runtime/collector.js";
import { startRetention, stopRetention } from "./runtime/retention.js";
import logSourceRoutes from "./runtime/routes.js";
import runtimeLogRoutes from "./runtime/log-routes.js";
import temporalRoutes from "./temporal-routes.js";
import railwayOAuthRoutes from "./railway-oauth.js";

const app = express();
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim())
  : undefined; // undefined = allow all in dev

app.use(cors({
  origin: allowedOrigins || true,
  credentials: true,
}));
// Capture raw body for webhook signature validation
app.use(cookieParser());
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Mount auth routes (no auth required on these)
app.use("/api/auth", authRoutes);

// Auth middleware — verifies Supabase access token OR API key
app.use("/api", async (req, res, next) => {
  const path = req.path;
  // Skip auth for public endpoints
  if (path === "/health" || path.startsWith("/webhooks/") || path.startsWith("/auth/") || path.startsWith("/railway-oauth/")) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Check API key first (for programmatic/MCP access)
  if (token && config.apiKey && token === config.apiKey) {
    // Set a service account user so RLS-protected routes work
    const serviceId = config.serviceUserId || "00000000-0000-0000-0000-000000000001";
    (req as any).user = {
      id: serviceId,
      login: "api-key",
      name: "API Key Service Account",
      avatarUrl: "",
      githubId: 0,
      accessToken: "__service__",
    } satisfies AuthenticatedUser;
    return next();
  }

  // Verify Supabase access token
  if (token) {
    try {
      const sb = getSupabase();
      const { data: { user }, error } = await sb.auth.getUser(token);
      if (!error && user) {
        const meta = user.user_metadata || {};
        (req as any).user = {
          id: user.id,
          login: meta.user_name || meta.preferred_username || "",
          name: meta.full_name || meta.name || null,
          avatarUrl: meta.avatar_url || "",
          githubId: meta.provider_id ? parseInt(meta.provider_id, 10) : 0,
          accessToken: token,
        } satisfies AuthenticatedUser;
        return next();
      }
    } catch {
      // Invalid token — fall through
    }
  }

  // Dev mode — only allowed when running locally (no RAILWAY_ENVIRONMENT set)
  if (!config.apiKey && !config.supabase.anonKey && !process.env.RAILWAY_ENVIRONMENT) {
    (req as any).user = {
      id: "00000000-0000-0000-0000-000000000000",
      login: "dev",
      name: "Dev Mode User",
      avatarUrl: "",
      githubId: 0,
      accessToken: "__dev__",
    } satisfies AuthenticatedUser;
    return next();
  }

  res.status(401).json({ error: "Unauthorized" });
});

// Mount routes after auth middleware
app.use("/api/railway-oauth", railwayOAuthRoutes);
app.use("/api/connections", connectionRoutes);
app.use("/api/log-sources", logSourceRoutes);
app.use("/api/runtime-logs", runtimeLogRoutes);
app.use("/api/temporal", temporalRoutes);
app.use("/api", routes);

async function start() {
  console.log("RepoGraph Backend starting...");

  // Listen FIRST so Railway's health check gets a response immediately
  app.listen(config.port, () => {
    console.log(`RepoGraph API running on http://localhost:${config.port}`);
  });

  // Initialize services in the background (non-blocking)
  await initServices();
}

async function initServices() {
  // Verify connections
  const neo4jOk = await verifyNeo4jConnection();
  if (neo4jOk) {
    console.log("Neo4j: connected");
    await initNeo4jIndexes();
  } else {
    console.warn("Neo4j: connection failed — graph features will not work");
  }

  const sbOk = await verifySupabaseConnection();
  if (sbOk) {
    console.log("Supabase: connected");
  } else {
    console.warn("Supabase: connection failed — check SUPABASE_URL and SUPABASE_SERVICE_KEY in .env");
  }

  // Verify git is available
  try {
    const { execSync } = await import("child_process");
    execSync("git --version", { stdio: "pipe" });
    console.log("Git: available");
  } catch {
    console.warn("Git: not found on PATH — clone operations will fail");
  }

  // Restart file watchers for repos with sync_mode = "watcher"
  if (sbOk) {
    try {
      await restartWatchers();
    } catch (err) {
      console.warn("Failed to restart watchers:", err);
    }
  }

  // Start runtime log collector and retention worker
  if (sbOk) {
    try {
      startCollector();
      startRetention();
    } catch (err) {
      console.warn("Runtime: failed to start collector/retention:", err);
    }
  }

  // Start job timeout checker — marks stuck jobs as failed every 60s
  const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  timeoutInterval = setInterval(async () => {
    try {
      const sb = getSupabase();
      const cutoff = new Date(Date.now() - JOB_TIMEOUT_MS).toISOString();
      const { data: stuckJobs } = await sb
        .from("digest_jobs")
        .select("id, repo_id")
        .eq("status", "running")
        .lt("started_at", cutoff);

      if (stuckJobs && stuckJobs.length > 0) {
        for (const stuckJob of stuckJobs) {
          await sb.from("digest_jobs").update({
            status: "failed",
            error_log: "Job timed out after 10 minutes",
          }).eq("id", stuckJob.id);
          await sb.from("repositories").update({
            status: "error",
          }).eq("id", stuckJob.repo_id);
          console.warn(`[timeout] Marked job ${stuckJob.id} as failed (timed out)`);
        }
      }
    } catch (err) {
      console.error("[timeout] Error checking stuck jobs:", err);
    }
  }, 60_000);
}

// Graceful shutdown
let timeoutInterval: ReturnType<typeof setInterval> | undefined;
async function shutdown(signal: string) {
  console.log(`Shutting down (${signal})...`);
  if (timeoutInterval) clearInterval(timeoutInterval);
  stopCollector();
  stopRetention();
  stopAllWatchers();
  await closeNeo4j();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().then(() => {
  // timeoutInterval is set inside initServices()
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
