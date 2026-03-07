import { spawn } from "child_process";
import { config } from "../../config.js";

export interface ScipRunResult {
  success: boolean;
  indexPath: string;
  durationMs: number;
  error?: string;
}

/**
 * Check if scip-typescript is available on PATH.
 */
export async function isScipAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn("scip-typescript", ["--version"], {
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
    const proc = spawn("scip-typescript", args, {
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
