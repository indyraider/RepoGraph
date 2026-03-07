import { spawn } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { config } from "../../config.js";

export interface ScipRunResult {
  success: boolean;
  indexPath: string;
  durationMs: number;
  error?: string;
}

/**
 * Resolve the scip-typescript binary path.
 * Prefers the local node_modules/.bin binary, falls back to PATH.
 */
function getScipBinary(): string {
  // Walk up from this file to find the backend package's node_modules/.bin
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const localBin = path.resolve(__dirname, "../../../node_modules/.bin/scip-typescript");
  if (existsSync(localBin)) return localBin;

  // Also check the monorepo root node_modules (hoisted)
  const rootBin = path.resolve(__dirname, "../../../../../node_modules/.bin/scip-typescript");
  if (existsSync(rootBin)) return rootBin;

  // Fall back to PATH
  return "scip-typescript";
}

/**
 * Check if scip-typescript is available.
 */
export async function isScipAvailable(): Promise<boolean> {
  const bin = getScipBinary();
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(bin, ["--version"], {
      stdio: "pipe",
      timeout: 5000,
    });
    proc.on("error", () => { if (!settled) { settled = true; resolve(false); } });
    proc.on("close", (code) => { if (!settled) { settled = true; resolve(code === 0); } });
  });
}

/**
 * Run scip-typescript index against a repo directory.
 * Returns the path to the emitted .scip file on success.
 */
export async function runScipTypescript(
  repoPath: string,
  outputPath: string,
  timeoutMs: number = config.scip.timeoutMs
): Promise<ScipRunResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ScipRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const args = [
      "index",
      "--cwd", repoPath,
      "--output", outputPath,
      "--infer-tsconfig",
    ];

    const maxMemory = config.scip.maxMemoryMb;
    const bin = getScipBinary();
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=${maxMemory}`,
      },
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[scip] ${text}`);
    });

    // Hard timeout
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({
        success: false,
        indexPath: outputPath,
        durationMs: Date.now() - startTime,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("error", (err) => {
      settle({
        success: false,
        indexPath: outputPath,
        durationMs: Date.now() - startTime,
        error: (err as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed" : err.message,
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        settle({
          success: true,
          indexPath: outputPath,
          durationMs: Date.now() - startTime,
        });
      } else {
        settle({
          success: false,
          indexPath: outputPath,
          durationMs: Date.now() - startTime,
          error: stderr.trim() || `exit code ${code}`,
        });
      }
    });
  });
}
