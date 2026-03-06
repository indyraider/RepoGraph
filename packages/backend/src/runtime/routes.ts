/**
 * Log Source API Routes — CRUD + test connection + toggle for log sources.
 * Mounted at /api/log-sources in index.ts.
 *
 * Note: These routes are protected by the auth middleware in index.ts.
 * Log sources are scoped by repo_id. In the current single-tenant deployment,
 * all authenticated users have access to all repos. Multi-tenant scoping
 * (user→repo ownership) would be added when user-repo permissions are implemented.
 */

import { Router, type Request, type Response } from "express";
import { getSupabase } from "../db/supabase.js";
import { encrypt, safeDecrypt } from "../lib/crypto.js";
import { getAdapter, getRegisteredPlatforms } from "./adapters/registry.js";
import type { AdapterConfig } from "./adapters/types.js";

const router = Router();

// GET /api/log-sources — list all log sources (tokens stripped)
router.get("/", async (_req: Request, res: Response) => {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("log_sources")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const sanitized = (data || []).map((source) => {
    const config = { ...(source.config as Record<string, unknown>) };
    delete config.encrypted_api_token;
    return { ...source, config };
  });

  res.json(sanitized);
});

// GET /api/log-sources/platforms — list registered adapter platforms
router.get("/platforms", (_req: Request, res: Response) => {
  res.json(getRegisteredPlatforms());
});

// POST /api/log-sources/test-connection — test before saving (create flow)
// IMPORTANT: Must be declared BEFORE /:id routes to avoid param shadowing
router.post("/test-connection", async (req: Request, res: Response) => {
  const { platform, api_token, config } = req.body;

  if (!platform || !api_token) {
    res.status(400).json({ error: "platform and api_token are required" });
    return;
  }

  const adapter = getAdapter(platform);
  if (!adapter) {
    res.json({ ok: false, error: `Unknown platform: ${platform}` });
    return;
  }

  const adapterConfig: AdapterConfig = {
    apiToken: api_token,
    platformConfig: config || {},
  };

  try {
    const result = await adapter.testConnection(adapterConfig);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/log-sources — create a new log source
router.post("/", async (req: Request, res: Response) => {
  const { repo_id, platform, display_name, api_token, config, polling_interval_sec, min_level } =
    req.body;

  if (!repo_id || !platform || !display_name || !api_token) {
    res.status(400).json({ error: "repo_id, platform, display_name, and api_token are required" });
    return;
  }

  if (!getAdapter(platform)) {
    res.status(400).json({
      error: `Unknown platform: ${platform}. Valid: ${getRegisteredPlatforms().map((p) => p.platform).join(", ")}`,
    });
    return;
  }

  // Strip any encrypted_api_token from incoming config, then encrypt the real token
  const { encrypted_api_token: _drop, ...safeConfig } = (config || {}) as Record<string, unknown>;
  const sourceConfig = {
    ...safeConfig,
    encrypted_api_token: encrypt(api_token),
  };

  const sb = getSupabase();
  const { data, error } = await sb
    .from("log_sources")
    .insert({
      repo_id,
      platform,
      display_name,
      config: sourceConfig,
      polling_interval_sec: polling_interval_sec || 30,
      min_level: min_level || "warn",
      enabled: true,
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const responseConfig = { ...(data.config as Record<string, unknown>) };
  delete responseConfig.encrypted_api_token;
  res.status(201).json({ ...data, config: responseConfig });
});

// PUT /api/log-sources/:id — update a log source
router.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { display_name, api_token, config, polling_interval_sec, min_level } = req.body;

  const sb = getSupabase();

  const { data: existing, error: fetchError } = await sb
    .from("log_sources")
    .select("config")
    .eq("id", id)
    .single();

  if (fetchError || !existing) {
    res.status(404).json({ error: "Log source not found" });
    return;
  }

  const existingConfig = (existing.config || {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  if (display_name !== undefined) updates.display_name = display_name;
  if (polling_interval_sec !== undefined) updates.polling_interval_sec = polling_interval_sec;
  if (min_level !== undefined) updates.min_level = min_level;

  if (config || api_token) {
    // Strip encrypted_api_token from incoming config to prevent injection
    const { encrypted_api_token: _drop, ...safeConfig } = (config || {}) as Record<string, unknown>;
    const newConfig = { ...existingConfig, ...safeConfig };
    if (api_token) {
      newConfig.encrypted_api_token = encrypt(api_token);
    }
    updates.config = newConfig;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const { data, error } = await sb
    .from("log_sources")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const responseConfig = { ...(data.config as Record<string, unknown>) };
  delete responseConfig.encrypted_api_token;
  res.json({ ...data, config: responseConfig });
});

// DELETE /api/log-sources/:id — remove a log source
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const sb = getSupabase();

  const { error } = await sb.from("log_sources").delete().eq("id", id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ ok: true });
});

// POST /api/log-sources/:id/test — test connection via saved source
router.post("/:id/test", async (req: Request, res: Response) => {
  const { id } = req.params;
  const sb = getSupabase();

  const { data: source, error: fetchError } = await sb
    .from("log_sources")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !source) {
    res.status(404).json({ error: "Log source not found" });
    return;
  }

  const adapter = getAdapter(source.platform);
  if (!adapter) {
    res.json({ ok: false, error: `Unknown platform: ${source.platform}` });
    return;
  }

  const config = (source.config || {}) as Record<string, unknown>;
  const encryptedToken = config.encrypted_api_token as string | undefined;
  if (!encryptedToken) {
    res.json({ ok: false, error: "No API token configured" });
    return;
  }

  const apiToken = safeDecrypt(encryptedToken);
  if (!apiToken) {
    res.json({ ok: false, error: "Failed to decrypt API token" });
    return;
  }

  const { encrypted_api_token: _, ...platformConfig } = config;
  const adapterConfig: AdapterConfig = { apiToken, platformConfig };

  try {
    const result = await adapter.testConnection(adapterConfig);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/log-sources/:id/toggle — flip enabled/disabled
router.post("/:id/toggle", async (req: Request, res: Response) => {
  const { id } = req.params;
  const sb = getSupabase();

  const { data: source, error: fetchError } = await sb
    .from("log_sources")
    .select("enabled")
    .eq("id", id)
    .single();

  if (fetchError || !source) {
    res.status(404).json({ error: "Log source not found" });
    return;
  }

  const { data, error } = await sb
    .from("log_sources")
    .update({ enabled: !source.enabled })
    .eq("id", id)
    .select("id, enabled")
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

export default router;
