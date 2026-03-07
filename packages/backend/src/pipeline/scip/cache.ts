import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../../config.js";

/**
 * Get the cache directory for SCIP indices.
 */
function getCacheDir(repoUrl: string): string {
  const hash = crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 12);
  return path.join(config.tempDir, "scip-cache", hash);
}

/**
 * Check if a cached SCIP index exists for the given repo and commit.
 * Returns the cached index path if found, null otherwise.
 */
export function checkCache(repoUrl: string, commitSha: string): string | null {
  const cacheFile = path.join(getCacheDir(repoUrl), `${commitSha}.scip`);
  if (fs.existsSync(cacheFile)) {
    return cacheFile;
  }
  return null;
}

/**
 * Cache a SCIP index file for the given repo and commit.
 * Best-effort — failures are silently ignored.
 */
export function cacheIndex(
  repoUrl: string,
  commitSha: string,
  indexPath: string
): void {
  try {
    const cacheDir = getCacheDir(repoUrl);
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `${commitSha}.scip`);
    fs.copyFileSync(indexPath, cacheFile);
  } catch {
    // Best-effort caching — don't fail the pipeline
  }
}

/**
 * Get a temp output path for the SCIP index file.
 */
export function getScipOutputPath(jobId: string): string {
  const dir = path.join(config.tempDir, "scip-jobs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${jobId}.scip`);
}

/**
 * Clean up the temp SCIP index file.
 */
export function cleanupScipOutput(outputPath: string): void {
  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  } catch {
    // Best-effort cleanup
  }
}
