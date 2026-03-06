/**
 * Log Retention Worker — prunes runtime_logs entries older than the retention window.
 * Runs as a periodic setInterval in the backend process.
 */

import { getSupabase } from "../db/supabase.js";

const RETENTION_DAYS = 30;
const RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Every hour
let retentionInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the retention worker. Call once at backend startup.
 */
export function startRetention(): void {
  if (retentionInterval) return;

  console.log(`[retention] Starting retention worker (${RETENTION_DAYS}-day window, checks hourly)`);
  retentionInterval = setInterval(pruneOldLogs, RETENTION_CHECK_INTERVAL_MS);

  // Run immediately on start
  pruneOldLogs();
}

/**
 * Stop the retention worker. Call on graceful shutdown.
 */
export function stopRetention(): void {
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
    console.log("[retention] Stopped");
  }
}

async function pruneOldLogs(): Promise<void> {
  try {
    const sb = getSupabase();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { count, error } = await sb
      .from("runtime_logs")
      .delete({ count: "exact" })
      .lt("timestamp", cutoff);

    if (error) {
      console.error("[retention] Prune error:", error.message);
      return;
    }

    if (count && count > 0) {
      console.log(`[retention] Pruned ${count} log entries older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error("[retention] Error:", err);
  }
}
