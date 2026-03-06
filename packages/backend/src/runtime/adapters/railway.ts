/**
 * Railway Adapter — fetches runtime logs and deployments from the Railway GraphQL API.
 *
 * API endpoint: POST https://backboard.railway.com/graphql/v2
 * Queries used:
 * - deployments(input: { projectId, serviceId }) — list deployments
 * - deploymentLogs(deploymentId, limit, startDate) — fetch logs per deployment
 */

import type {
  LogAdapter,
  AdapterConfig,
  ConnectionResult,
  NormalizedLogEntry,
  NormalizedDeployment,
} from "./types.js";

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const MAX_RETRIES = 3;

interface GqlResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function railwayGql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  token: string
): Promise<GqlResponse<T>> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(RAILWAY_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status !== 429) {
      if (!res.ok) {
        throw new Error(`Railway API ${res.status}: ${await res.text()}`);
      }
      return res.json() as Promise<GqlResponse<T>>;
    }

    lastResponse = res;
    if (attempt < MAX_RETRIES) {
      const backoff = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw new Error(`Railway API rate limited after ${MAX_RETRIES} retries (${lastResponse?.status})`);
}

function normalizeSeverity(severity: string): "info" | "warn" | "error" {
  const lower = (severity || "").toLowerCase();
  if (lower === "error" || lower === "err") return "error";
  if (lower === "warn" || lower === "warning") return "warn";
  return "info";
}

function mapDeploymentStatus(status: string): string {
  const lower = (status || "").toLowerCase();
  switch (lower) {
    case "success":
      return "ready";
    case "failed":
      return "error";
    case "building":
    case "deploying":
    case "initializing":
      return "building";
    case "crashed":
      return "error";
    case "removed":
    case "cancelled":
      return "cancelled";
    default:
      return lower || "unknown";
  }
}

export const railwayAdapter: LogAdapter = {
  platform: "railway",
  displayName: "Railway",

  async testConnection(config: AdapterConfig): Promise<ConnectionResult> {
    const { apiToken } = config;

    try {
      const result = await railwayGql<{ me: { name: string } }>(
        `query { me { name } }`,
        {},
        apiToken
      );

      if (result.errors?.length) {
        return { ok: false, error: result.errors[0].message };
      }

      return {
        ok: true,
        meta: {
          latestLogTimestamp: undefined,
          entryCount: undefined,
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
    const serviceId = platformConfig.service_id as string;
    const environmentId = platformConfig.environment_id as string | undefined;

    // Step 1: List recent deployments
    const deployResult = await railwayGql<{
      deployments: {
        edges: Array<{
          node: { id: string; status: string; createdAt: string };
        }>;
      };
    }>(
      `query deployments($input: DeploymentListInput!) {
        deployments(input: $input, first: 10) {
          edges {
            node {
              id
              status
              createdAt
            }
          }
        }
      }`,
      {
        input: {
          projectId,
          serviceId,
          ...(environmentId ? { environmentId } : {}),
        },
      },
      apiToken
    );

    if (deployResult.errors?.length) {
      throw new Error(`Railway deployments: ${deployResult.errors[0].message}`);
    }

    const deployments = deployResult.data?.deployments?.edges || [];
    if (deployments.length === 0) return [];

    // Step 2: Fetch logs for each deployment
    const allEntries: NormalizedLogEntry[] = [];

    for (const edge of deployments) {
      const deploy = edge.node;
      try {
        const logsResult = await railwayGql<{
          deploymentLogs: Array<{
            timestamp: string;
            message: string;
            severity: string;
          }>;
        }>(
          `query deploymentLogs($deploymentId: String!, $limit: Int, $startDate: DateTime) {
            deploymentLogs(deploymentId: $deploymentId, limit: $limit, startDate: $startDate) {
              timestamp
              message
              severity
            }
          }`,
          {
            deploymentId: deploy.id,
            limit: 500,
            startDate: since.toISOString(),
          },
          apiToken
        );

        if (logsResult.errors?.length) continue;

        for (const log of logsResult.data?.deploymentLogs || []) {
          const timestamp = new Date(log.timestamp);
          if (timestamp <= since) continue;

          allEntries.push({
            source: "railway",
            level: normalizeSeverity(log.severity),
            message: log.message,
            timestamp,
            deploymentId: deploy.id,
            metadata: {
              serviceName: platformConfig.service_name,
              environmentId,
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
    const serviceId = platformConfig.service_id as string;
    const environmentId = platformConfig.environment_id as string | undefined;

    const result = await railwayGql<{
      deployments: {
        edges: Array<{
          node: {
            id: string;
            status: string;
            createdAt: string;
            updatedAt: string;
            staticUrl?: string;
            meta?: { commitHash?: string; branch?: string };
          };
        }>;
      };
    }>(
      `query deployments($input: DeploymentListInput!) {
        deployments(input: $input, first: 20) {
          edges {
            node {
              id
              status
              createdAt
              updatedAt
              staticUrl
              meta {
                commitHash
                branch
              }
            }
          }
        }
      }`,
      {
        input: {
          projectId,
          serviceId,
          ...(environmentId ? { environmentId } : {}),
        },
      },
      apiToken
    );

    if (result.errors?.length) {
      throw new Error(`Railway deployments: ${result.errors[0].message}`);
    }

    return (result.data?.deployments?.edges || [])
      .map((edge): NormalizedDeployment => {
        const d = edge.node;
        return {
          source: "railway",
          deploymentId: d.id,
          status: mapDeploymentStatus(d.status),
          branch: d.meta?.branch,
          commitSha: d.meta?.commitHash,
          startedAt: new Date(d.createdAt),
          completedAt: d.updatedAt ? new Date(d.updatedAt) : undefined,
          url: d.staticUrl || undefined,
        };
      })
      .filter((d) => d.startedAt >= since);
  },
};
