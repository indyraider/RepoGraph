import chokidar, { type FSWatcher } from "chokidar";
import { syncManager, type SyncTrigger } from "./manager.js";

interface WatcherEntry {
  repoId: string;
  url: string;
  branch: string;
  localPath: string;
  debounceMs: number;
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const activeWatchers = new Map<string, WatcherEntry>();

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/coverage/**",
  "**/.turbo/**",
];

export function startWatcher(
  repoId: string,
  url: string,
  branch: string,
  localPath: string,
  debounceMs = 30_000
): void {
  // Stop existing watcher for this repo if any
  stopWatcher(repoId);

  console.log(`[watcher] Starting watcher for ${url} at ${localPath} (debounce: ${debounceMs}ms)`);

  const fsWatcher = chokidar.watch(localPath, {
    ignored: IGNORE_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    usePolling: false,
  });

  const entry: WatcherEntry = {
    repoId,
    url,
    branch,
    localPath,
    debounceMs,
    watcher: fsWatcher,
    debounceTimer: null,
  };

  const handleChange = () => {
    // Reset debounce timer on every change
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }

    entry.debounceTimer = setTimeout(async () => {
      entry.debounceTimer = null;
      console.log(`[watcher] Debounce fired for ${url}, triggering digest`);

      try {
        const trigger: SyncTrigger = {
          repoId: entry.repoId,
          url: entry.url,
          branch: entry.branch,
          localPath: entry.localPath,
          trigger: "watcher",
        };

        const result = await syncManager.trigger(trigger);
        console.log(`[watcher] Trigger result for ${url}: ${result.status}`);
      } catch (err) {
        console.error(`[watcher] Failed to trigger digest for ${url}:`, err);
      }
    }, entry.debounceMs);
  };

  fsWatcher.on("add", handleChange);
  fsWatcher.on("change", handleChange);
  fsWatcher.on("unlink", handleChange);

  fsWatcher.on("error", (err) => {
    console.error(`[watcher] Error watching ${localPath}:`, err);
  });

  activeWatchers.set(repoId, entry);
}

export function stopWatcher(repoId: string): void {
  const entry = activeWatchers.get(repoId);
  if (entry) {
    console.log(`[watcher] Stopping watcher for ${entry.url}`);
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.watcher.close();
    activeWatchers.delete(repoId);
  }
}

export function stopAllWatchers(): void {
  for (const [repoId] of activeWatchers) {
    stopWatcher(repoId);
  }
}

export function isWatching(repoId: string): boolean {
  return activeWatchers.has(repoId);
}

/**
 * Restart watchers for all repos that have sync_mode = "watcher".
 * Called on backend startup.
 */
export async function restartWatchers(): Promise<void> {
  const { getSupabase } = await import("../db/supabase.js");
  const sb = getSupabase();

  const { data: repos, error } = await sb
    .from("repositories")
    .select("id, url, branch, sync_mode, sync_config")
    .eq("sync_mode", "watcher");

  if (error || !repos) {
    console.warn("[watcher] Failed to query repos for watcher restart:", error?.message);
    return;
  }

  for (const repo of repos) {
    const config = repo.sync_config as Record<string, unknown> || {};
    const localPath = config.local_path as string;
    const debounceMs = (config.debounce_ms as number) || 30_000;

    if (!localPath) {
      console.warn(`[watcher] Repo ${repo.url} has sync_mode=watcher but no local_path in sync_config`);
      continue;
    }

    // Verify path exists
    try {
      const { access } = await import("fs/promises");
      await access(localPath);
    } catch {
      console.warn(`[watcher] Local path ${localPath} does not exist for repo ${repo.url}, skipping`);
      continue;
    }

    startWatcher(repo.id, repo.url, repo.branch, localPath, debounceMs);
  }

  console.log(`[watcher] Restarted ${activeWatchers.size} watcher(s)`);
}
