import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { verifyNeo4jConnection, initNeo4jIndexes, closeNeo4j } from "./db/neo4j.js";
import { verifySupabaseConnection, getSupabase } from "./db/supabase.js";
import { restartWatchers, stopAllWatchers } from "./sync/watcher.js";
import routes from "./routes.js";
import authRoutes, { COOKIE_NAME, type JwtPayload } from "./auth.js";

const app = express();
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim())
  : undefined; // undefined = allow all in dev

app.use(cors({
  origin: allowedOrigins || true,
  credentials: true,
}));
app.use(cookieParser());
// Capture raw body for webhook signature validation
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Mount auth routes (no auth required on these)
app.use("/api/auth", authRoutes);

// Auth middleware — supports JWT cookie OR API key
app.use("/api", (req, res, next) => {
  const path = req.path;
  // Skip auth for public endpoints
  if (path === "/health" || path.startsWith("/webhooks/") || path.startsWith("/auth/")) {
    return next();
  }

  // Check JWT cookie first
  const sessionToken = req.cookies?.[COOKIE_NAME];
  if (sessionToken) {
    try {
      const payload = jwt.verify(sessionToken, config.sessionSecret) as JwtPayload;
      (req as any).user = payload;
      return next();
    } catch {
      // Invalid cookie — fall through to API key check
    }
  }

  // Check API key (for programmatic/MCP access)
  if (config.apiKey) {
    const authHeader = req.headers.authorization;
    const apiKeyToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (apiKeyToken && apiKeyToken === config.apiKey) {
      return next();
    }
  }

  // No API key configured = dev mode, allow all
  if (!config.apiKey && !config.githubClientId) {
    return next();
  }

  res.status(401).json({ error: "Unauthorized" });
}, routes);

async function start() {
  console.log("RepoGraph Backend starting...");

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

  // Start job timeout checker — marks stuck jobs as failed every 60s
  const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const timeoutInterval = setInterval(async () => {
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

  app.listen(config.port, () => {
    console.log(`RepoGraph API running on http://localhost:${config.port}`);
  });

  return timeoutInterval;
}

// Graceful shutdown
let timeoutInterval: ReturnType<typeof setInterval> | undefined;
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  if (timeoutInterval) clearInterval(timeoutInterval);
  stopAllWatchers();
  await closeNeo4j();
  process.exit(0);
});

start().then((interval) => {
  timeoutInterval = interval;
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
