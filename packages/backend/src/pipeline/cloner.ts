import { simpleGit } from "simple-git";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config.js";

export class PrivateRepoError extends Error {
  constructor(url: string) {
    super(
      `Repository "${url}" is private or not found. ` +
      (config.githubToken
        ? "Your GITHUB_TOKEN may not have access to this repository."
        : "Set GITHUB_TOKEN in your .env file to access private repositories.")
    );
    this.name = "PrivateRepoError";
  }
}

export interface CloneResult {
  localPath: string;
  commitSha: string;
}

/**
 * If a GITHUB_TOKEN is configured and the URL is HTTPS GitHub,
 * inject the token for authenticated cloning.
 */
function getAuthenticatedUrl(url: string): string {
  if (!config.githubToken) return url;
  const match = url.match(/^https:\/\/github\.com\/(.+)$/);
  if (match) {
    return `https://${config.githubToken}@github.com/${match[1]}`;
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
  depth: number = 1
): Promise<CloneResult> {
  await fs.mkdir(config.tempDir, { recursive: true });
  const localPath = path.join(config.tempDir, randomUUID());

  const cloneUrl = getAuthenticatedUrl(url);
  const git = simpleGit();

  const cloneArgs = depth > 0 ? ["--depth", String(depth), "--branch", branch] : ["--branch", branch];

  try {
    await git.clone(cloneUrl, localPath, cloneArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAuthError(msg)) {
      throw new PrivateRepoError(url);
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
