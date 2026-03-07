import { simpleGit } from "simple-git";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config.js";

export class PrivateRepoError extends Error {
  constructor(url: string, hasToken: boolean) {
    super(
      `Repository "${url}" is private or not found. ` +
      (hasToken
        ? "Your GitHub token may not have access to this repository."
        : "Please re-login to grant access to private repositories.")
    );
    this.name = "PrivateRepoError";
  }
}

export class RepoOwnedError extends Error {
  constructor(url: string) {
    super(`Repository "${url}" is owned by another user.`);
    this.name = "RepoOwnedError";
  }
}

export interface CloneResult {
  localPath: string;
  commitSha: string;
}

/**
 * Inject a GitHub token into the clone URL for authenticated cloning.
 * Prefers the per-user token; falls back to server-level GITHUB_TOKEN.
 */
function getAuthenticatedUrl(url: string, userToken?: string): string {
  const token = userToken || config.githubToken;
  if (!token) return url;
  const match = url.match(/^https:\/\/github\.com\/(.+)$/);
  if (match) {
    return `https://${token}@github.com/${match[1]}`;
  }
  return url;
}

function isAuthError(message: string): boolean {
  const patterns = [
    "Authentication failed",
    "could not read Username",
    "Repository not found",
    "remote: Repository not found",
    "fatal: repository .* not found",
    "ERROR: Repository not found",
    "The requested URL returned error: 403",
    "The requested URL returned error: 404",
  ];
  return patterns.some((p) => new RegExp(p, "i").test(message));
}

export async function cloneRepo(
  url: string,
  branch: string,
  depth: number = 1,
  githubToken?: string
): Promise<CloneResult> {
  await fs.mkdir(config.tempDir, { recursive: true });
  const localPath = path.join(config.tempDir, randomUUID());

  const cloneUrl = getAuthenticatedUrl(url, githubToken);
  const git = simpleGit();

  const cloneArgs = depth > 0 ? ["--depth", String(depth), "--branch", branch] : ["--branch", branch];

  try {
    await git.clone(cloneUrl, localPath, cloneArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAuthError(msg)) {
      throw new PrivateRepoError(url, !!(githubToken || config.githubToken));
    }
    throw err;
  }

  // Get commit SHA
  const repoGit = simpleGit(localPath);
  const log = await repoGit.log({ maxCount: 1 });
  const commitSha = log.latest?.hash || "unknown";

  return { localPath, commitSha };
}

export async function cleanupClone(localPath: string): Promise<void> {
  try {
    await fs.rm(localPath, { recursive: true, force: true });
  } catch {
    console.warn(`Failed to cleanup ${localPath}`);
  }
}
