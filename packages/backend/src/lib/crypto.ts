/**
 * Shared encryption utilities — AES-256-GCM with session secret as key material.
 * Extracted from connections.ts so both connection routes and runtime collector can use them.
 */

import crypto from "crypto";
import { config } from "../config.js";

function deriveKey(): Buffer {
  return crypto.scryptSync(config.sessionSecret, "repograph-connections", 32);
}

export function encrypt(text: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all base64)
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decrypt(encoded: string): string {
  const key = deriveKey();
  const [ivB64, tagB64, dataB64] = encoded.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Safe decrypt — returns null instead of throwing on corrupt/invalid data. */
export function safeDecrypt(encoded: string): string | null {
  try {
    return decrypt(encoded);
  } catch {
    return null;
  }
}

export function encryptCredentials(creds: Record<string, string>): Record<string, string> {
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    encrypted[k] = v ? encrypt(v) : "";
  }
  return encrypted;
}

export function decryptCredentials(creds: Record<string, string>): Record<string, string> {
  const decrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    try {
      decrypted[k] = v ? decrypt(v) : "";
    } catch {
      decrypted[k] = ""; // corrupted — return empty
    }
  }
  return decrypted;
}

export function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}
