import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_KREXEL_API_URL = "https://api.krexel.com";

interface StoredAuth {
  api_key?: unknown;
  api_url?: unknown;
}

function storedAuthPath(env: NodeJS.ProcessEnv): string {
  const configuredHome = env.KREXEL_HOME?.trim();
  const home = configuredHome
    ? path.resolve(configuredHome)
    : path.join(os.homedir(), ".krexel");
  return path.join(home, "auth.json");
}

function readStoredAuth(env: NodeJS.ProcessEnv): StoredAuth | null {
  try {
    return JSON.parse(readFileSync(storedAuthPath(env), "utf8")) as StoredAuth;
  } catch {
    return null;
  }
}

/** Environment variables win; `krexel login`'s auth file is the fallback. */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.KREXEL_API_KEY?.trim();
  if (explicit) return explicit;
  const stored = readStoredAuth(env)?.api_key;
  return typeof stored === "string" ? stored.trim() : "";
}

export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.KREXEL_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const stored = readStoredAuth(env)?.api_url;
  if (typeof stored === "string" && stored.trim()) {
    return stored.trim().replace(/\/+$/, "");
  }
  return DEFAULT_KREXEL_API_URL;
}
