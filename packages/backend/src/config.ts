import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

// Load .env from project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  neo4j: {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
    database: process.env.NEO4J_DATABASE || "neo4j",
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    key: process.env.SUPABASE_SERVICE_KEY || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  },
  tempDir: process.env.TEMP_DIR || "/tmp/repograph",
  githubToken: process.env.GITHUB_TOKEN || "",
  apiKey: process.env.API_KEY || "",
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  railwayClientId: process.env.RAILWAY_OAUTH_CLIENT_ID || "",
  railwayClientSecret: process.env.RAILWAY_OAUTH_CLIENT_SECRET || "",
  serviceUserId: process.env.REPOGRAPH_SERVICE_USER_ID || "",
  scip: {
    enabled: process.env.SCIP_ENABLED !== "false",
    timeoutMs: parseInt(process.env.SCIP_TIMEOUT_MS || "300000", 10), // 5 minutes
    maxMemoryMb: parseInt(process.env.SCIP_MAX_MEMORY_MB || "4096", 10),
  },
  codeql: {
    enabled: process.env.CODEQL_ENABLED === "true", // opt-in, not installed by default
    timeoutMs: parseInt(process.env.CODEQL_TIMEOUT_MS || "900000", 10), // 15 minutes
    maxDiskMb: parseInt(process.env.CODEQL_MAX_DISK_MB || "2048", 10),
  },
};
