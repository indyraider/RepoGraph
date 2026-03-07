import { getSupabase } from "../db/supabase.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runDigest, DigestRequest, DigestResult } from "../pipeline/digest.js";

export interface WebhookCommit {
  sha: string;
  message: string;
}

export interface SyncTrigger {
  repoId: string;
  url: string;
  branch: string;
  localPath?: string;
  trigger: "webhook" | "watcher" | "manual";
  /** Commit info extracted from the webhook payload. */
  commits?: WebhookCommit[];
}

export interface SyncTriggerResult {
  status: "started" | "queued" | "skipped" | "error";
  message?: string;
  syncEventId?: string;
}

interface RepoSyncState {
  running: boolean;
  pending: boolean;
  latestTrigger?: SyncTrigger;
}

class SyncManager {
  private repoStates = new Map<string, RepoSyncState>();

  private getState(repoId: string): RepoSyncState {
    let state = this.repoStates.get(repoId);
    if (!state) {
      state = { running: false, pending: false };
      this.repoStates.set(repoId, state);
    }
    return state;
  }

  /**
   * Check if a digest is currently running for the given repo URL.
   * Used by routes.ts to maintain backward compatibility with the
   * existing double-submit guard.
   */
  isRunning(repoId: string): boolean {
    return this.getState(repoId).running;
  }

  /**
   * Trigger a digest for a repository. Handles concurrency:
   * NOTE: Caller MUST verify repo ownership before calling this method.
   * This method uses the service-role client internally and does not enforce RLS.
   * - If no digest is running, starts one immediately.
   * - If a digest is already running, queues the trigger (coalesces to latest).
   * - Returns the status.
   */
  async trigger(opts: SyncTrigger): Promise<SyncTriggerResult> {
    const state = this.getState(opts.repoId);

    if (state.running) {
      // Coalesce: save the latest trigger, run it when current finishes
      state.pending = true;
      state.latestTrigger = opts;
      console.log(`[sync] Digest already running for ${opts.url}, queued for re-run`);
      return { status: "queued", message: "Digest already running, queued for re-run after completion" };
    }

    return this.executeDigest(opts, state);
  }

  private async executeDigest(opts: SyncTrigger, state: RepoSyncState): Promise<SyncTriggerResult> {
    state.running = true;
    state.pending = false;

    const sb = getSupabase();
    const startedAt = new Date().toISOString();

    // Create sync event record
    let syncEventId: string | undefined;
    try {
      const { data: evt } = await sb
        .from("sync_events")
        .insert({
          repo_id: opts.repoId,
          trigger: opts.trigger,
          started_at: startedAt,
          status: "running",
        })
        .select("id")
        .single();
      syncEventId = evt?.id;
    } catch (err) {
      console.warn("[sync] Failed to create sync event:", err);
    }

    try {
      const digestReq: DigestRequest = {
        url: opts.url,
        branch: opts.branch,
        localPath: opts.localPath,
        trigger: opts.trigger,
      };

      const result = await runDigest(digestReq);

      // Update sync event with success
      if (syncEventId) {
        const summary: Record<string, unknown> = {};
        if (opts.commits && opts.commits.length > 0) {
          summary.commits = opts.commits;
        }
        if (result.changedPaths && result.changedPaths.length > 0) {
          summary.changedPaths = result.changedPaths;
        }
        if (result.deletedPaths && result.deletedPaths.length > 0) {
          summary.deletedPaths = result.deletedPaths;
        }

        await sb
          .from("sync_events")
          .update({
            completed_at: new Date().toISOString(),
            files_changed: result.stats.changedFiles ?? result.stats.fileCount,
            files_removed: result.stats.deletedFiles ?? 0,
            duration_ms: result.stats.durationMs,
            status: "success",
            ...(Object.keys(summary).length > 0 ? { summary } : {}),
          })
          .eq("id", syncEventId);
      }

      // Update last_synced_at and last_synced_sha (read commit_sha that runDigest stored)
      const { data: repoData } = await sb
        .from("repositories")
        .select("commit_sha")
        .eq("id", opts.repoId)
        .single();

      await sb
        .from("repositories")
        .update({
          last_synced_at: new Date().toISOString(),
          last_synced_sha: repoData?.commit_sha || null,
        })
        .eq("id", opts.repoId);

      return { status: "started", syncEventId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sync] Digest failed for ${opts.url}:`, errorMsg);

      // Update sync event with failure
      if (syncEventId) {
        await sb
          .from("sync_events")
          .update({
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - new Date(startedAt).getTime(),
            status: "failed",
            error_log: errorMsg,
          })
          .eq("id", syncEventId);
      }

      return { status: "error", message: errorMsg };
    } finally {
      state.running = false;

      // If a trigger was queued while this digest was running, execute it now
      if (state.pending && state.latestTrigger) {
        const nextTrigger = state.latestTrigger;
        state.latestTrigger = undefined;
        console.log(`[sync] Running queued digest for ${nextTrigger.url}`);
        // Fire and forget — don't await (the caller already returned)
        this.executeDigest(nextTrigger, state).catch((err) => {
          console.error("[sync] Queued digest failed:", err);
        });
      }
    }
  }

  /**
   * Update sync mode for a repository.
   * NOTE: Caller MUST verify repo ownership before calling. Uses service-role client.
   */
  async updateMode(
    repoId: string,
    mode: "off" | "webhook" | "watcher",
    config: Record<string, unknown> = {}
  ): Promise<{ webhookUrl?: string; webhookSecret?: string }> {
    const sb = getSupabase();
    const result: { webhookUrl?: string; webhookSecret?: string } = {};

    if (mode === "webhook") {
      // Generate webhook secret if not provided
      const { randomBytes } = await import("crypto");
      const secret = config.webhook_secret as string || randomBytes(32).toString("hex");
      config = { ...config, webhook_secret: secret };
      result.webhookSecret = secret;
      result.webhookUrl = "/api/webhooks/github";
    }

    await sb
      .from("repositories")
      .update({ sync_mode: mode, sync_config: config })
      .eq("id", repoId);

    return result;
  }

  /**
   * Get sync status for a repository.
   * @param sb Optional user-scoped Supabase client for RLS enforcement.
   *           Falls back to service key if not provided.
   */
  async getStatus(repoId: string, sb?: SupabaseClient): Promise<{
    sync_mode: string;
    sync_config: Record<string, unknown>;
    last_synced_at: string | null;
    last_synced_sha: string | null;
    is_running: boolean;
    is_pending: boolean;
  }> {
    sb = sb || getSupabase();
    const { data } = await sb
      .from("repositories")
      .select("sync_mode, sync_config, last_synced_at, last_synced_sha")
      .eq("id", repoId)
      .single();

    const state = this.getState(repoId);

    return {
      sync_mode: data?.sync_mode || "off",
      sync_config: data?.sync_config || {},
      last_synced_at: data?.last_synced_at || null,
      last_synced_sha: data?.last_synced_sha || null,
      is_running: state.running,
      is_pending: state.pending,
    };
  }

  /**
   * Get recent sync events for a repository.
   * @param sb Optional user-scoped Supabase client for RLS enforcement.
   *           Falls back to service key if not provided.
   */
  async getEvents(repoId: string, limit = 20, sb?: SupabaseClient): Promise<unknown[]> {
    sb = sb || getSupabase();
    const { data, error } = await sb
      .from("sync_events")
      .select("*")
      .eq("repo_id", repoId)
      .order("started_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    return data || [];
  }
}

// Singleton
export const syncManager = new SyncManager();
