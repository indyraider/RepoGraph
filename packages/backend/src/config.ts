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
  },
  tempDir: process.env.TEMP_DIR || "/tmp/repograph",
  githubToken: process.env.GITHUB_TOKEN || "",
  apiKey: process.env.API_KEY || "",
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
};
