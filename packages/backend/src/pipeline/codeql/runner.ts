import { spawn } from "child_process";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { config } from "../../config.js";
import { CodeQLLanguageConfig, CodeQLRunResult } from "./types.js";

// --- Language Config Registry ---

const javascriptConfig: CodeQLLanguageConfig = {
  language: "javascript",
  querySuite: "codeql/javascript-security-queries",
  extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
  label: "codeql-javascript",
};

// Future language configs go here (same pattern as SCIP adapters):
// const pythonConfig: CodeQLLanguageConfig = { ... };
// const javaConfig: CodeQLLanguageConfig = { ... };

const configRegistry = new Map<string, CodeQLLanguageConfig>([
  ["typescript", javascriptConfig],
  ["tsx", javascriptConfig],
  ["javascript", javascriptConfig],
  // ["python", pythonConfig],
  // ["java", javaConfig],
  // ["go", goConfig],
]);

/**
 * Get all unique CodeQL language configs for a set of detected languages.
 * Deduplicates (e.g., typescript/tsx/javascript all map to the same config).
 */
export function getCodeQLConfigsForLanguages(
  languages: string[]
): CodeQLLanguageConfig[] {
  const seen = new Set<string>();
  const configs: CodeQLLanguageConfig[] = [];

  for (const lang of languages) {
    const cfg = configRegistry.get(lang);
    if (cfg && !seen.has(cfg.language)) {
      seen.add(cfg.language);
      configs.push(cfg);
    }
  }

  return configs;
}

// --- CLI Availability Check ---

/**
 * Check if the CodeQL CLI is available on PATH.
 */
export async function isCodeQLAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn("codeql", ["--version"], {
      stdio: "pipe",
      timeout: 10000,
    });
    proc.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0);
      }
    });
  });
}

// --- Database Creation ---

/**
 * Create a CodeQL database for the given repo and language.
 * This copies source into CodeQL's internal format — after this call,
 * the original repo directory can be safely deleted.
 */
export async function createCodeQLDatabase(
  repoPath: string,
  dbOutputDir: string,
  language: string,
  timeoutMs: number = config.codeql.timeoutMs
): Promise<CodeQLRunResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CodeQLRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const args = [
      "database",
      "create",
      dbOutputDir,
      `--language=${language}`,
      `--source-root=${repoPath}`,
      "--overwrite",
    ];

    console.log(`[codeql] Creating database for ${language}...`);
    const proc = spawn("codeql", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[codeql-db] ${text}`);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({
        success: false,
        durationMs: Date.now() - startTime,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("error", (err) => {
      settle({
        success: false,
        durationMs: Date.now() - startTime,
        error:
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "not_installed"
            : err.message,
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(
          `[codeql] Database created in ${Date.now() - startTime}ms`
        );
        settle({ success: true, durationMs: Date.now() - startTime });
      } else {
        settle({
          success: false,
          durationMs: Date.now() - startTime,
          error: stderr.trim() || `exit code ${code}`,
        });
      }
    });
  });
}

// --- Analysis ---

/**
 * Run CodeQL analysis against a database, producing SARIF output.
 * The database is a self-contained copy — the original repo is not needed.
 */
export async function runCodeQLAnalysis(
  dbPath: string,
  sarifOutputPath: string,
  querySuite: string,
  timeoutMs: number = config.codeql.timeoutMs
): Promise<CodeQLRunResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CodeQLRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const args = [
      "database",
      "analyze",
      dbPath,
      "--format=sarif-latest",
      `--output=${sarifOutputPath}`,
      querySuite,
    ];

    console.log(`[codeql] Running analysis with ${querySuite}...`);
    const proc = spawn("codeql", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[codeql-analyze] ${text}`);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({
        success: false,
        durationMs: Date.now() - startTime,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("error", (err) => {
      settle({
        success: false,
        durationMs: Date.now() - startTime,
        error: err.message,
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(
          `[codeql] Analysis completed in ${Date.now() - startTime}ms`
        );
        settle({ success: true, durationMs: Date.now() - startTime });
      } else {
        settle({
          success: false,
          durationMs: Date.now() - startTime,
          error: stderr.trim() || `exit code ${code}`,
        });
      }
    });
  });
}

// --- Cleanup ---

/**
 * Remove a CodeQL database directory from disk.
 */
export async function cleanupCodeQLDatabase(dbPath: string): Promise<void> {
  try {
    if (existsSync(dbPath)) {
      await rm(dbPath, { recursive: true, force: true });
      console.log(`[codeql] Cleaned up database at ${dbPath}`);
    }
  } catch (err) {
    console.warn(
      `[codeql] Failed to clean up database at ${dbPath}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Get the CodeQL database path for a given job and language.
 */
export function getCodeQLDbPath(jobId: string, language: string): string {
  return path.join(config.tempDir, "codeql-jobs", jobId, `${language}-db`);
}

/**
 * Get the SARIF output path for a given job and language.
 */
export function getSarifOutputPath(jobId: string, language: string): string {
  return path.join(
    config.tempDir,
    "codeql-jobs",
    jobId,
    `${language}-results.sarif`
  );
}
