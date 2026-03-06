/**
 * Adapter Registry — maps platform identifiers to LogAdapter instances.
 * Consumed by the collector (poll loop) and backend routes (test connection, validate platform).
 */

import type { LogAdapter } from "./types.js";
import { vercelAdapter } from "./vercel.js";
import { railwayAdapter } from "./railway.js";

const adapters = new Map<string, LogAdapter>();

// Register first-party adapters
adapters.set(vercelAdapter.platform, vercelAdapter);
adapters.set(railwayAdapter.platform, railwayAdapter);

/** Get an adapter by platform identifier. Returns undefined if not registered. */
export function getAdapter(platform: string): LogAdapter | undefined {
  return adapters.get(platform);
}

/** Get all registered platform identifiers (for UI dropdown / validation). */
export function getRegisteredPlatforms(): Array<{
  platform: string;
  displayName: string;
}> {
  return Array.from(adapters.values()).map((a) => ({
    platform: a.platform,
    displayName: a.displayName,
  }));
}
