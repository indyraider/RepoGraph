import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import { getSupabase } from "../db/supabase.js";
import { syncManager } from "./manager.js";

/**
 * Validate GitHub webhook signature using HMAC-SHA256.
 */
function validateSignature(rawBody: Buffer, secret: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Handle GitHub push webhook events.
 */
export async function handleGitHubWebhook(req: Request, res: Response): Promise<void> {
  const event = req.headers["x-github-event"] as string;

  // Only handle push events
  if (event !== "push") {
    res.status(200).json({ status: "ignored", reason: `event type '${event}' not handled` });
    return;
  }

  const body = req.body;
  const cloneUrl = body?.repository?.clone_url as string | undefined;
  const sshUrl = body?.repository?.ssh_url as string | undefined;
  const ref = body?.ref as string | undefined;
  const afterSha = body?.after as string | undefined;

  if (!cloneUrl && !sshUrl) {
    res.status(400).json({ error: "Missing repository URL in payload" });
    return;
  }

  if (!ref) {
    res.status(400).json({ error: "Missing ref in payload" });
    return;
  }

  // Extract branch name from ref (refs/heads/main → main)
  const branch = ref.replace(/^refs\/heads\//, "");

  // Look up the repo by matching clone_url or ssh_url
  // GitHub always sends URLs with .git suffix, but users may have registered
  // the repo without it — check both variants.
  const sb = getSupabase();
  const rawUrls = [cloneUrl, sshUrl].filter(Boolean) as string[];
  const candidateUrls = [
    ...rawUrls,
    ...rawUrls.map((u) => u.replace(/\.git$/, "")),
  ];
  // Deduplicate
  const uniqueUrls = [...new Set(candidateUrls)];
  const { data: repos } = await sb
    .from("repositories")
    .select("id, url, branch, sync_mode, sync_config, commit_sha")
    .in("url", uniqueUrls);

  if (!repos || repos.length === 0) {
    res.status(404).json({ error: "Repository not registered in RepoGraph" });
    return;
  }

  const repo = repos[0];

  // Verify webhook is enabled
  if (repo.sync_mode !== "webhook") {
    res.status(200).json({ status: "ignored", reason: "webhook sync not enabled for this repo" });
    return;
  }

  // Validate signature
  const signature = req.headers["x-hub-signature-256"] as string;
  const webhookSecret = (repo.sync_config as Record<string, unknown>)?.webhook_secret as string;

  if (webhookSecret && signature) {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      console.warn("[webhook] Raw body not available for signature validation");
      res.status(500).json({ error: "Raw body not available for signature validation" });
      return;
    }

    if (!validateSignature(rawBody, webhookSecret, signature)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
  } else if (webhookSecret && !signature) {
    res.status(401).json({ error: "Webhook secret configured but no signature provided" });
    return;
  }

  // Check if branch matches
  if (repo.branch !== branch) {
    res.status(200).json({ status: "ignored", reason: `push to branch '${branch}', repo tracks '${repo.branch}'` });
    return;
  }

  // Check if SHA is same (no changes)
  if (afterSha && repo.commit_sha === afterSha) {
    res.status(200).json({ status: "skipped", reason: "commit SHA unchanged" });
    return;
  }

  // Extract commit info from webhook payload
  const rawCommits = Array.isArray(body?.commits) ? body.commits : [];
  const commits = rawCommits
    .map((c: Record<string, unknown>) => ({
      sha: String(c.id ?? "").slice(0, 8),
      message: String(c.message ?? "").split("\n")[0].slice(0, 120),
    }))
    .filter((c: { sha: string; message: string }) => c.sha && c.message);

  // Trigger digest via Sync Manager
  const result = await syncManager.trigger({
    repoId: repo.id,
    url: repo.url,
    branch: repo.branch,
    trigger: "webhook",
    commits,
  });

  res.status(200).json(result);
}
