/**
 * Log Collector — polls enabled log sources on a schedule, invokes adapters,
 * runs stack trace parsing on errors, and batch-inserts into Supabase.
 *
 * Runs as a setInterval in the backend process (same pattern as job timeout checker).
 */

import { getSupabase } from "../db/supabase.js";
import { safeDecrypt } from "../lib/crypto.js";
import { getAdapter } from "./adapters/registry.js";
import { parseStackTrace } from "./stack-parser.js";
import { syncManager } from "../sync/manager.js";
import type { AdapterConfig, NormalizedLogEntry, NormalizedDeployment } from "./adapters/types.js";

const POLL_CHECK_INTERVAL_MS = 10_000; // Check for due sources every 10 seconds
let collectorInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false; // Guard against overlapping poll cycles

// Track per-source backoff after rate limit / repeated errors
const sourceBackoff = new Map<string, { until: number; factor: number }>();
const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes max

/**
 * Start the collector. Call once at backend startup (after Supabase is verified).
 */
export function startCollector(): void {
  if (collectorInterval) return;

  console.log("[collector] Starting log collector (poll check every 10s)");
  collectorInterval = setInterval(pollCycle, POLL_CHECK_INTERVAL_MS);

  // Run immediately on start
  pollCycle();
}

/**
 * Stop the collector. Call on graceful shutdown.
 */
export function stopCollector(): void {
  if (collectorInterval) {
    clearInterval(collectorInterval);
    collectorInterval = null;
    console.log("[collector] Stopped");
  }
}

/**
 * Single poll cycle — find due sources and process each one.
 */
async function pollCycle(): Promise<void> {
  if (isPolling) return; // Skip if previous cycle still running
  isPolling = true;

  try {
    const sb = getSupabase();

    // Find sources that are enabled and due for polling
    const { data: sources, error } = await sb
      .from("log_sources")
      .select("*")
      .eq("enabled", true);

    if (error || !sources) {
      if (error) console.error("[collector] Failed to query log_sources:", error.message);
      return;
    }

    const now = Date.now();

    for (const source of sources) {
      const sourceId = source.id as string;

      // Check backoff (rate limit / repeated errors)
      const backoff = sourceBackoff.get(sourceId);
      if (backoff && now < backoff.until) continue;

      // Check if this source is due for polling
      const lastPoll = source.last_poll_at ? new Date(source.last_poll_at).getTime() : 0;
      const intervalMs = (source.polling_interval_sec || 60) * 1000;
      if (now - lastPoll < intervalMs) continue;

      await processSource(source);
    }
  } catch (err) {
    console.error("[collector] Poll cycle error:", err);
  } finally {
    isPolling = false;
  }
}

/**
 * Process a single log source — decrypt token, call adapter, parse stack traces, insert.
 */
async function processSource(source: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  const sourceId = source.id as string;
  const repoId = source.repo_id as string;
  const platform = source.platform as string;
  const config = (source.config || {}) as Record<string, unknown>;
  const minLevel = source.min_level as string || "warn";

  // Load adapter
  const adapter = getAdapter(platform);
  if (!adapter) {
    await updateSourceError(sourceId, `Unknown platform: ${platform}`);
    return;
  }

  // Decrypt API token
  const encryptedToken = config.encrypted_api_token as string | undefined;
  if (!encryptedToken) {
    await updateSourceError(sourceId, "No API token configured");
    return;
  }

  const apiToken = safeDecrypt(encryptedToken);
  if (!apiToken) {
    await updateSourceError(sourceId, "Failed to decrypt API token (corrupt or key changed)");
    return;
  }

  // Build adapter config (everything except the encrypted token)
  const { encrypted_api_token: _, ...platformConfig } = config;
  const adapterConfig: AdapterConfig = { apiToken, platformConfig };

  const since = source.last_poll_at
    ? new Date(source.last_poll_at as string)
    : new Date(Date.now() - 30 * 60 * 1000); // Default: 30 minutes ago

  try {
    // Fetch logs
    const entries = await adapter.fetchSince(adapterConfig, since);

    // Filter by min_level
    const levelPriority: Record<string, number> = { info: 0, warn: 1, error: 2 };
    const minPriority = levelPriority[minLevel] ?? 1;
    const filtered = entries.filter((e) => (levelPriority[e.level] ?? 0) >= minPriority);

    // Parse stack traces for error entries
    for (const entry of filtered) {
      if (entry.level === "error" && !entry.filePath && entry.message) {
        // Check if the message contains a stack trace
        const frames = parseStackTrace(entry.stackTrace || entry.message);
        if (frames.length > 0) {
          entry.filePath = frames[0].filePath;
          entry.lineNumber = frames[0].lineNumber;
          entry.functionName = entry.functionName || frames[0].functionName;
          // If stack trace was embedded in message, extract it
          if (!entry.stackTrace && entry.message.includes("\n    at ")) {
            entry.stackTrace = entry.message;
          }
        }
      }
    }

    // Batch insert logs (map camelCase → snake_case)
    if (filtered.length > 0) {
      const rows = filtered.map((e) => ({
        repo_id: repoId,
        source: e.source,
        level: e.level,
        message: e.message,
        timestamp: e.timestamp,
        deployment_id: e.deploymentId || null,
        function_name: e.functionName || null,
        file_path: e.filePath || null,
        line_number: e.lineNumber || null,
        stack_trace: e.stackTrace || null,
        metadata: e.metadata || {},
      }));

      const { error: insertError } = await sb.from("runtime_logs").insert(rows);
      if (insertError) {
        console.error(`[collector] Failed to insert logs for source ${sourceId}:`, insertError.message);
        await updateSourceError(sourceId, `Insert failed: ${insertError.message}`);
        return; // Don't advance cursor — retry these logs next cycle
      }
    }

    // Fetch and upsert deployments (if adapter supports it)
    if (adapter.fetchDeployments) {
      try {
        const deployments = await adapter.fetchDeployments(adapterConfig, since);
        if (deployments.length > 0) {
          const deployRows = deployments.map((d) => ({
            repo_id: repoId,
            source: d.source,
            deployment_id: d.deploymentId,
            status: d.status,
            branch: d.branch || null,
            commit_sha: d.commitSha || null,
            started_at: d.startedAt,
            completed_at: d.completedAt || null,
            url: d.url || null,
          }));

          const { error: deployError } = await sb
            .from("deployments")
            .upsert(deployRows, { onConflict: "repo_id,deployment_id,source" });

          if (deployError) {
            console.error(`[collector] Failed to upsert deployments for source ${sourceId}:`, deployError.message);
          } else {
            // Auto-digest: trigger re-digest when a new successful deploy is detected
            await triggerAutoDigestIfNeeded(repoId, deployments);
          }
        }
      } catch (deployErr) {
        // Deployment fetch failure is non-fatal — log and continue
        console.warn(`[collector] Deployment fetch failed for source ${sourceId}:`, deployErr);
      }
    }

    // Success — update cursor, clear error, and reset backoff
    sourceBackoff.delete(sourceId);
    await sb
      .from("log_sources")
      .update({ last_poll_at: new Date().toISOString(), last_error: null })
      .eq("id", sourceId);

    if (filtered.length > 0) {
      console.log(`[collector] ${platform}/${sourceId}: ingested ${filtered.length} log entries`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[collector] ${platform}/${sourceId} error:`, msg);
    await updateSourceError(sourceId, msg);

    // Apply exponential backoff on rate limits or repeated failures
    const isRateLimit = msg.includes("rate limit") || msg.includes("429");
    const prev = sourceBackoff.get(sourceId);
    const factor = prev ? Math.min(prev.factor * 2, 32) : (isRateLimit ? 4 : 2);
    const backoffMs = Math.min(factor * 15_000, MAX_BACKOFF_MS); // 60s → 120s → ... → 10min
    sourceBackoff.set(sourceId, { until: Date.now() + backoffMs, factor });
    console.warn(`[collector] ${platform}/${sourceId} backing off ${Math.round(backoffMs / 1000)}s`);
  }
}

// Track which deploy commit SHAs we've already triggered digests for
const autoDigestSeen = new Set<string>();

/**
 * After detecting a new successful deployment, trigger an incremental re-digest
 * so the code graph stays fresh. Only fires once per commit SHA.
 */
async function triggerAutoDigestIfNeeded(
  repoId: string,
  deployments: NormalizedDeployment[]
): Promise<void> {
  // Find newly completed successful deploys
  const successStatuses = new Set(["ready", "success", "succeeded", "READY", "SUCCESS"]);
  const newSuccessful = deployments.filter(
    (d) => successStatuses.has(d.status) && d.commitSha && !autoDigestSeen.has(d.commitSha)
  );

  if (newSuccessful.length === 0) return;

  // Mark as seen to avoid re-triggering
  for (const d of newSuccessful) autoDigestSeen.add(d.commitSha!);

  // Get repo details
  const sb = getSupabase();
  const { data: repo } = await sb
    .from("repositories")
    .select("url, branch, commit_sha")
    .eq("id", repoId)
    .single();

  if (!repo) return;

  // Only trigger if the deploy commit is newer than what we last digested
  const latestDeploy = newSuccessful[0];
  if (repo.commit_sha === latestDeploy.commitSha) return;

  console.log(
    `[collector] New deploy detected (${latestDeploy.commitSha?.slice(0, 7)}), triggering auto-digest for ${repo.url}`
  );

  // Fire-and-forget — don't block the collector
  syncManager
    .trigger({
      repoId,
      url: repo.url,
      branch: repo.branch,
      trigger: "webhook", // reuse webhook trigger type
    })
    .catch((err) => {
      console.error("[collector] Auto-digest trigger failed:", err);
    });
}

async function updateSourceError(sourceId: string, error: string): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from("log_sources").update({ last_error: error }).eq("id", sourceId);
  } catch {
    // Best-effort error update
  }
}
