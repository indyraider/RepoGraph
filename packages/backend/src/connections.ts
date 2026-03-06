import { Router, type Request, type Response } from "express";
import { getSupabase } from "./db/supabase.js";
import { createUserClient } from "./db/supabase.js";
import {
  encryptCredentials,
  decryptCredentials,
  maskValue,
} from "./lib/crypto.js";
import type { AuthenticatedUser } from "./auth.js";

const router = Router();

function getUser(req: Request): AuthenticatedUser | null {
  return (req as any).user || null;
}

// GET /api/connections — list all connections for the current user
router.get("/", async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const sb = createUserClient(user.accessToken);
  const { data, error } = await sb
    .from("user_connections")
    .select("*")
    .order("provider");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Return with masked credentials
  const masked = (data || []).map((conn) => {
    const creds = conn.credentials as Record<string, string>;
    const decrypted = decryptCredentials(creds);
    const maskedCreds: Record<string, string> = {};
    for (const [k, v] of Object.entries(decrypted)) {
      maskedCreds[k] = v ? maskValue(v) : "";
    }
    return { ...conn, credentials: maskedCreds };
  });

  res.json(masked);
});

// GET /api/connections/mcp-config — return full decrypted credentials for MCP config generation
router.get("/mcp-config", async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const sb = createUserClient(user.accessToken);
  const { data, error } = await sb
    .from("user_connections")
    .select("*");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const neo4j = (data || []).find((c) => c.provider === "neo4j");
  const supabase = (data || []).find((c) => c.provider === "supabase");

  const neo4jCreds = neo4j ? decryptCredentials(neo4j.credentials as Record<string, string>) : null;
  const supabaseCreds = supabase ? decryptCredentials(supabase.credentials as Record<string, string>) : null;

  res.json({
    neo4j: neo4jCreds,
    supabase: supabaseCreds,
  });
});

// PUT /api/connections/:provider — upsert a connection
router.put("/:provider", async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const provider = req.params.provider as string;
  if (!["neo4j", "supabase"].includes(provider)) {
    res.status(400).json({ error: "Provider must be 'neo4j' or 'supabase'" });
    return;
  }

  const { credentials, label = "default" } = req.body;
  if (!credentials || typeof credentials !== "object") {
    res.status(400).json({ error: "credentials object is required" });
    return;
  }

  // Validate expected fields
  if (provider === "neo4j") {
    const { uri, username, password } = credentials;
    if (!uri || !username || !password) {
      res.status(400).json({ error: "neo4j requires uri, username, and password" });
      return;
    }
  } else if (provider === "supabase") {
    const { url, service_key } = credentials;
    if (!url || !service_key) {
      res.status(400).json({ error: "supabase requires url and service_key" });
      return;
    }
  }

  const encrypted = encryptCredentials(credentials);

  // Use service role for upsert (needs to set owner_id, which RLS allows for the user)
  const sb = getSupabase();
  const { data, error } = await sb
    .from("user_connections")
    .upsert(
      {
        owner_id: user.id,
        github_id: user.githubId,
        provider,
        label,
        credentials: encrypted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "github_id,provider,label" }
    )
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ id: data.id, provider, label, status: "saved" });
});

// DELETE /api/connections/:provider — remove a connection
router.delete("/:provider", async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const provider = req.params.provider as string;

  const sb = createUserClient(user.accessToken);
  const { error } = await sb
    .from("user_connections")
    .delete()
    .eq("provider", provider);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ ok: true });
});

// POST /api/connections/neo4j/test — test a Neo4j connection without saving
router.post("/neo4j/test", async (req: Request, res: Response) => {
  const { uri, username, password } = req.body;
  if (!uri || !username || !password) {
    res.status(400).json({ error: "uri, username, and password are required" });
    return;
  }

  try {
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(uri, neo4j.default.auth.basic(username, password));
    const serverInfo = await driver.getServerInfo();
    await driver.close();
    res.json({ ok: true, version: serverInfo.protocolVersion?.toString() || "connected" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, error: msg });
  }
});

export default router;
