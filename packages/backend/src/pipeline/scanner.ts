import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

export interface ScannedFile {
  path: string; // relative path within repo
  absolutePath: string;
  language: string;
  sizeBytes: number;
  content: string;
  contentHash: string;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".sql": "sql",
  ".sh": "shell",
  ".toml": "toml",
  ".xml": "xml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".svelte": "svelte",
  ".vue": "vue",
};

const SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "vendor",
  "coverage",
  ".turbo",
];

// Max file size to index (500KB)
const MAX_FILE_SIZE = 500 * 1024;

export async function scanRepo(repoPath: string): Promise<ScannedFile[]> {
  const ignorePatterns = SKIP_DIRS.map((d) => `**/${d}/**`);

  const files = await fg("**/*", {
    cwd: repoPath,
    ignore: ignorePatterns,
    dot: false,
    onlyFiles: true,
    absolute: false,
  });

  const results: ScannedFile[] = [];

  for (const relPath of files) {
    const absPath = path.join(repoPath, relPath);
    const ext = path.extname(relPath).toLowerCase();
    const language = EXTENSION_LANGUAGE_MAP[ext] || "unknown";

    // Skip binary and unknown files
    if (language === "unknown" && !isTextExtension(ext)) continue;

    try {
      const stat = await fs.stat(absPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      if (stat.size === 0) continue;

      const content = await fs.readFile(absPath, "utf-8");
      const contentHash = createHash("sha256").update(content).digest("hex");

      results.push({
        path: relPath,
        absolutePath: absPath,
        language,
        sizeBytes: stat.size,
        content,
        contentHash,
      });
    } catch {
      // Skip files we can't read (binary, encoding issues)
      continue;
    }
  }

  return results;
}

function isTextExtension(ext: string): boolean {
  const textExts = new Set([
    ".txt",
    ".env",
    ".example",
    ".gitignore",
    ".dockerignore",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc",
    ".babelrc",
    ".npmrc",
    ".nvmrc",
    "",
  ]);
  return textExts.has(ext);
}
