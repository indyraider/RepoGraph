/**
 * Log Adapter Interface — the contract all platform adapters implement.
 * Adding a new platform means implementing this interface and registering
 * the adapter in the registry.
 */

export interface AdapterConfig {
  apiToken: string;
  platformConfig: Record<string, unknown>;
}

export interface ConnectionResult {
  ok: boolean;
  error?: string;
  meta?: {
    latestLogTimestamp?: string;
    entryCount?: number;
  };
}

export interface NormalizedLogEntry {
  source: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: Date;
  deploymentId?: string;
  functionName?: string;
  filePath?: string;
  lineNumber?: number;
  stackTrace?: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedDeployment {
  source: string;
  deploymentId: string;
  status: string;
  branch?: string;
  commitSha?: string;
  startedAt: Date;
  completedAt?: Date;
  url?: string;
}

export interface LogAdapter {
  platform: string;
  displayName: string;

  /** Validate credentials and return a connection status. */
  testConnection(config: AdapterConfig): Promise<ConnectionResult>;

  /** Fetch all log entries after `since`. Return normalized entries. */
  fetchSince(
    config: AdapterConfig,
    since: Date
  ): Promise<NormalizedLogEntry[]>;

  /** Fetch recent deployments (optional — not all platforms have this concept). */
  fetchDeployments?(
    config: AdapterConfig,
    since: Date
  ): Promise<NormalizedDeployment[]>;
}
