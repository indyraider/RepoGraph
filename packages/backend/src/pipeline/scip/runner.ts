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

// --- Language Adapter Interface ---

export interface ScipLanguageAdapter {
  /** Language identifier (e.g., "typescript", "rust", "python") */
  language: string;
  /** File extensions this adapter handles */
  extensions: string[];
  /** Resolve the indexer binary path. Returns null if not installed. */
  resolveBinary(): string | null;
  /** Build CLI args for the indexer */
  buildArgs(repoPath: string, outputPath: string): string[];
  /** Build environment variables for the indexer process */
  buildEnv(): Record<string, string>;
  /** Label for log messages */
  label: string;
}

// --- TypeScript Adapter ---

const typescriptAdapter: ScipLanguageAdapter = {
  language: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  label: "scip-typescript",

  resolveBinary(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const localBin = path.resolve(__dirname, "../../../node_modules/.bin/scip-typescript");
    if (existsSync(localBin)) return localBin;

    const rootBin = path.resolve(__dirname, "../../../../../node_modules/.bin/scip-typescript");
    if (existsSync(rootBin)) return rootBin;

    return "scip-typescript";
  },

  buildArgs(repoPath: string, outputPath: string): string[] {
    return ["index", "--cwd", repoPath, "--output", outputPath, "--infer-tsconfig"];
  },

  buildEnv(): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      NODE_OPTIONS: `--max-old-space-size=${config.scip.maxMemoryMb}`,
    };
  },
};

// --- Rust Adapter ---

const rustAdapter: ScipLanguageAdapter = {
  language: "rust",
  extensions: [".rs"],
  label: "rust-analyzer",

  resolveBinary(): string | null {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const cargoPath = path.join(homeDir, ".cargo/bin/rust-analyzer");
    if (existsSync(cargoPath)) return cargoPath;

    return "rust-analyzer";
  },

  buildArgs(repoPath: string, outputPath: string): string[] {
    return ["scip", repoPath, "--output", outputPath];
  },

  buildEnv(): Record<string, string> {
    return { ...process.env as Record<string, string> };
  },
};

// --- Python Adapter ---

const pythonAdapter: ScipLanguageAdapter = {
  language: "python",
  extensions: [".py"],
  label: "scip-python",

  resolveBinary(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const localBin = path.resolve(__dirname, "../../../node_modules/.bin/scip-python");
    if (existsSync(localBin)) return localBin;

    return "scip-python";
  },

  buildArgs(repoPath: string, outputPath: string): string[] {
    return ["index", repoPath, "--output", outputPath];
  },

  buildEnv(): Record<string, string> {
    return { ...process.env as Record<string, string> };
  },
};

// --- Java Adapter (also handles Kotlin) ---

const javaAdapter: ScipLanguageAdapter = {
  language: "java",
  extensions: [".java", ".kt"],
  label: "scip-java",

  resolveBinary(): string | null {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const coursierPath = path.join(homeDir, ".local/share/coursier/bin/scip-java");
    if (existsSync(coursierPath)) return coursierPath;

    return "scip-java";
  },

  buildArgs(repoPath: string, outputPath: string): string[] {
    return ["index", "--cwd", repoPath, "--output", outputPath];
  },

  buildEnv(): Record<string, string> {
    return { ...process.env as Record<string, string> };
  },
};

// --- Adapter Registry ---

const adapterRegistry = new Map<string, ScipLanguageAdapter>([
  ["typescript", typescriptAdapter],
  ["tsx", typescriptAdapter],
  ["javascript", typescriptAdapter],
  ["rust", rustAdapter],
  ["python", pythonAdapter],
  ["java", javaAdapter],
  ["kotlin", javaAdapter],
]);

/**
 * Get the SCIP adapter for a given language.
 */
export function getScipAdapter(language: string): ScipLanguageAdapter | null {
  return adapterRegistry.get(language) || null;
}

/**
 * Get all unique SCIP adapters needed for a set of languages.
 * Deduplicates (e.g., typescript/tsx/javascript all map to the same adapter).
 */
export function getAdaptersForLanguages(languages: string[]): ScipLanguageAdapter[] {
  const seen = new Set<string>();
  const adapters: ScipLanguageAdapter[] = [];

  for (const lang of languages) {
    const adapter = adapterRegistry.get(lang);
    if (adapter && !seen.has(adapter.label)) {
      seen.add(adapter.label);
      adapters.push(adapter);
    }
  }

  return adapters;
}

/**
 * Check if a SCIP adapter's binary is available on this system.
 */
export async function isAdapterAvailable(adapter: ScipLanguageAdapter): Promise<boolean> {
  const bin = adapter.resolveBinary();
  if (!bin) return false;

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
 * Backward-compatible: check if scip-typescript is available.
 */
export async function isScipAvailable(): Promise<boolean> {
  return isAdapterAvailable(typescriptAdapter);
}

/**
 * Run a SCIP indexer using the given language adapter.
 */
export async function runScipIndexer(
  adapter: ScipLanguageAdapter,
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

    const bin = adapter.resolveBinary();
    if (!bin) {
      settle({
        success: false,
        indexPath: outputPath,
        durationMs: 0,
        error: "not_installed",
      });
      return;
    }

    const args = adapter.buildArgs(repoPath, outputPath);
    const env = adapter.buildEnv();

    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[${adapter.label}] ${text}`);
    });

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

/**
 * Backward-compatible wrapper: run scip-typescript.
 */
export async function runScipTypescript(
  repoPath: string,
  outputPath: string,
  timeoutMs: number = config.scip.timeoutMs
): Promise<ScipRunResult> {
  return runScipIndexer(typescriptAdapter, repoPath, outputPath, timeoutMs);
}
