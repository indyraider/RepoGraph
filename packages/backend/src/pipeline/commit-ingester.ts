import { simpleGit } from "simple-git";
import { getSession } from "../db/neo4j.js";
import { getSupabase } from "../db/supabase.js";

export interface CommitMeta {
  sha: string;
  author: string;
  authorEmail: string;
  timestamp: Date;
  message: string;
  parentShas: string[];
}

export interface CommitIngestionResult {
  commitsIngested: number;
  commits: CommitMeta[];
}

const BATCH_SIZE = 100;

/**
 * Extract commit history from a local repo and ingest into Neo4j + Supabase.
 * Creates Commit nodes, HAS_COMMIT edges, PARENT_OF edges, and Supabase rows.
 * Returns the ingested commits so downstream phases (temporal loader) can use
 * the commit metadata for attribution (changed_by, valid_from_ts, etc.).
 *
 * @param localPath  Path to cloned repo (must have git history)
 * @param repoUrl    Repository URL (used as Neo4j identity key)
 * @param repoId     Supabase repository UUID
 * @param maxCommits Maximum number of commits to ingest (default: 1)
 */
export async function ingestCommitHistory(
  localPath: string,
  repoUrl: string,
  repoId: string,
  maxCommits: number = 1
): Promise<CommitIngestionResult> {
  const git = simpleGit(localPath);

  // Extract commit metadata from git log
  let commits: CommitMeta[];
  try {
    const log = await git.log({ maxCount: maxCommits });
    commits = log.all.map((entry) => ({
      sha: entry.hash,
      author: entry.author_name,
      authorEmail: entry.author_email,
      timestamp: new Date(entry.date),
      message: entry.message,
      parentShas: [], // populated below via raw git log
    }));
  } catch (err) {
    console.warn(
      "[commit-ingester] Failed to read git log:",
      err instanceof Error ? err.message : err
    );
    return { commitsIngested: 0, commits: [] };
  }

  if (commits.length === 0) return { commitsIngested: 0, commits: [] };

  // Extract parent SHAs via raw git log format
  try {
    const rawLog = await git.raw([
      "log",
      `--max-count=${maxCommits}`,
      "--format=%H %P",
    ]);
    const parentMap = new Map<string, string[]>();
    for (const line of rawLog.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split(" ");
      const sha = parts[0];
      const parents = parts.slice(1).filter(Boolean);
      parentMap.set(sha, parents);
    }
    for (const commit of commits) {
      commit.parentShas = parentMap.get(commit.sha) || [];
    }
  } catch (err) {
    console.warn(
      "[commit-ingester] Failed to extract parent SHAs:",
      err instanceof Error ? err.message : err
    );
  }

  // Write to Neo4j
  const session = getSession();
  try {
    // Batch create Commit nodes + HAS_COMMIT edges
    for (let i = 0; i < commits.length; i += BATCH_SIZE) {
      const batch = commits.slice(i, i + BATCH_SIZE).map((c) => ({
        sha: c.sha,
        author: c.author,
        author_email: c.authorEmail,
        timestamp: c.timestamp.toISOString(),
        message: c.message,
        repo_url: repoUrl,
      }));

      await session.run(
        `UNWIND $commits AS c
         MERGE (commit:Commit {sha: c.sha, repo_url: c.repo_url})
         SET commit.author = c.author,
             commit.author_email = c.author_email,
             commit.timestamp = datetime(c.timestamp),
             commit.message = c.message
         WITH commit, c
         MATCH (r:Repository {url: c.repo_url})
         MERGE (r)-[:HAS_COMMIT]->(commit)`,
        { commits: batch }
      );
    }

    // Create PARENT_OF edges (only when multiple commits are ingested —
    // with depth=1 parent SHAs reference commits not in the graph)
    if (commits.length > 1) {
      const parentEdges: { sha: string; parentSha: string; repoUrl: string }[] = [];
      for (const commit of commits) {
        for (const parentSha of commit.parentShas) {
          parentEdges.push({ sha: commit.sha, parentSha, repoUrl });
        }
      }

      for (let i = 0; i < parentEdges.length; i += BATCH_SIZE) {
        const batch = parentEdges.slice(i, i + BATCH_SIZE);

        await session.run(
          `UNWIND $edges AS e
           MATCH (child:Commit {sha: e.sha, repo_url: e.repoUrl})
           MATCH (parent:Commit {sha: e.parentSha, repo_url: e.repoUrl})
           MERGE (parent)-[:PARENT_OF]->(child)`,
          { edges: batch }
        );
      }
    }
  } finally {
    await session.close();
  }

  // Write to Supabase
  const sb = getSupabase();
  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE).map((c) => ({
      repo_id: repoId,
      sha: c.sha,
      author: c.author,
      author_email: c.authorEmail,
      timestamp: c.timestamp.toISOString(),
      message: c.message,
      parent_shas: c.parentShas,
    }));

    const { error } = await sb
      .from("commits")
      .upsert(batch, { onConflict: "repo_id,sha" });

    if (error) {
      console.error(`[commit-ingester] Supabase upsert failed:`, error.message);
    }
  }

  console.log(`[commit-ingester] Ingested ${commits.length} commit(s)`);
  return { commitsIngested: commits.length, commits };
}
