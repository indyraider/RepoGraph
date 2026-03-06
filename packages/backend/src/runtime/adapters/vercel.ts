/**
 * Vercel Adapter — fetches runtime logs and deployments from the Vercel REST API.
 *
 * API endpoints used:
 * - GET /v6/deployments?projectId=X&since=T — list deployments
 * - GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs — structured runtime logs
 */

import type {
  LogAdapter,
  AdapterConfig,
  ConnectionResult,
  NormalizedLogEntry,
  NormalizedDeployment,
} from "./types.js";

const VERCEL_API = "https://api.vercel.com";
const MAX_RETRIES = 3;

async function vercelFetch(
  path: string,
  token: string,
  teamSlug?: string
): Promise<Response> {
  const url = new URL(path, VERCEL_API);
  if (teamSlug) url.searchParams.set("slug", teamSlug);

  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status !== 429) return res;

    lastResponse = res;
    if (attempt < MAX_RETRIES) {
      const backoff = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return lastResponse!;
}

function normalizeLevel(type: string): "info" | "warn" | "error" {
  switch (type) {
    case "error":
    case "stderr":
    case "fatal":
      return "error";
    case "warning":
      return "warn";
    default:
      return "info";
  }
}

function mapDeploymentStatus(state: string): string {
  switch (state) {
    case "READY":
      return "ready";
    case "ERROR":
      return "error";
    case "BUILDING":
    case "INITIALIZING":
      return "building";
    case "CANCELED":
      return "cancelled";
    case "QUEUED":
      return "running";
    default:
      return state.toLowerCase();
  }
}

export const vercelAdapter: LogAdapter = {
  platform: "vercel",
  displayName: "Vercel",

  async testConnection(config: AdapterConfig): Promise<ConnectionResult> {
    const { apiToken, platformConfig } = config;
    const projectId = platformConfig.project_id as string | undefined;
    const teamSlug = platformConfig.team_slug as string | undefined;

    if (!projectId) {
      return { ok: false, error: "project_id is required in config" };
    }

    try {
      const res = await vercelFetch(
        `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
        apiToken,
        teamSlug
      );

      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Vercel API ${res.status}: ${body}` };
      }

      const data = await res.json();
      const deploys = data.deployments || [];
      return {
        ok: true,
        meta: {
          entryCount: deploys.length,
          latestLogTimestamp: deploys[0]?.created
            ? new Date(deploys[0].created).toISOString()
            : undefined,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async fetchSince(
    config: AdapterConfig,
    since: Date
  ): Promise<NormalizedLogEntry[]> {
    const { apiToken, platformConfig } = config;
    const projectId = platformConfig.project_id as string;
    const teamSlug = platformConfig.team_slug as string | undefined;

    // Step 1: List recent deployments since the cursor
    const sinceMs = since.getTime();
    const deploymentsRes = await vercelFetch(
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&since=${sinceMs}&limit=10`,
      apiToken,
      teamSlug
    );

    if (!deploymentsRes.ok) {
      throw new Error(`Vercel deployments API ${deploymentsRes.status}`);
    }

    const deploymentsData = await deploymentsRes.json();
    const deployments = deploymentsData.deployments || [];

    if (deployments.length === 0) return [];

    // Step 2: Fetch runtime logs for each deployment
    const allEntries: NormalizedLogEntry[] = [];

    for (const deploy of deployments) {
      try {
        const logsRes = await vercelFetch(
          `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploy.uid)}/runtime-logs`,
          apiToken,
          teamSlug
        );

        if (!logsRes.ok) continue;

        const logsText = await logsRes.text();
        // Runtime logs endpoint returns newline-delimited JSON
        const logLines = logsText
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        for (const log of logLines) {
          const timestamp = new Date(log.timestampInMs || log.created || Date.now());
          if (timestamp <= since) continue;

          allEntries.push({
            source: "vercel",
            level: normalizeLevel(log.level || log.type || "info"),
            message: log.message || log.text || "",
            timestamp,
            deploymentId: deploy.uid,
            functionName: log.source || undefined,
            metadata: {
              requestPath: log.requestPath,
              requestMethod: log.requestMethod,
              statusCode: log.responseStatusCode,
              domain: log.domain,
              rowId: log.rowId,
            },
          });
        }
      } catch {
        // Skip individual deployment log failures
        continue;
      }
    }

    return allEntries;
  },

  async fetchDeployments(
    config: AdapterConfig,
    since: Date
  ): Promise<NormalizedDeployment[]> {
    const { apiToken, platformConfig } = config;
    const projectId = platformConfig.project_id as string;
    const teamSlug = platformConfig.team_slug as string | undefined;

    const sinceMs = since.getTime();
    const res = await vercelFetch(
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&since=${sinceMs}&limit=20`,
      apiToken,
      teamSlug
    );

    if (!res.ok) {
      throw new Error(`Vercel deployments API ${res.status}`);
    }

    const data = await res.json();
    return (data.deployments || []).map(
      (d: Record<string, unknown>): NormalizedDeployment => ({
        source: "vercel",
        deploymentId: d.uid as string,
        status: mapDeploymentStatus((d.state || d.readyState || "UNKNOWN") as string),
        branch: (d.meta as Record<string, unknown>)?.githubCommitRef as string | undefined,
        commitSha: (d.meta as Record<string, unknown>)?.githubCommitSha as string | undefined,
        startedAt: new Date((d.created || d.createdAt || Date.now()) as number),
        completedAt: d.ready ? new Date(d.ready as number) : undefined,
        url: d.url ? `https://${d.url}` : undefined,
      })
    );
  },
};
