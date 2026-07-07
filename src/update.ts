import type { PatchOp, PatchResponse } from "./schemas.js";

/**
 * update_site core — applies a list of patch operations to a deployed site
 * via the Krexel orchestrator's `POST /api/v1/deploy/patch` endpoint.
 *
 * Unlike ship_site, no folder is bundled client-side: we send a small JSON
 * manifest describing what to change. The worker materializes the new
 * site tree from the previous deploy's R2 objects + the patches.
 *
 * Quota: each patch deploy costs 0.1 of a full deploy. The 0.1 constant
 * is enforced server-side but we surface it locally too so the LLM can
 * tell the user "0.3/10 deploys used" without round-tripping.
 */

export const PATCH_QUOTA_COST = 0.1;

/**
 * Defense-in-depth path check. The zod regex in schemas.ts already rejects
 * most bad paths, but we also reject:
 *   - empty paths
 *   - leading slash (would mean absolute path on the server)
 *   - any `..` segment (path traversal)
 */
export function sanitizeFilePath(file: string): string {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("file path must be a non-empty string");
  }
  if (file.startsWith("/")) {
    throw new Error(`file path must not start with '/': ${file}`);
  }
  if (file !== file.trim()) {
    throw new Error(`file path must not have leading/trailing whitespace: ${JSON.stringify(file)}`);
  }
  // Reject any segment that is exactly '..' or '.'
  const segments = file.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`file path must not contain '..' segments: ${file}`);
    }
    if (seg === "." && segments.length > 1) {
      throw new Error(`file path must not contain '.' segments: ${file}`);
    }
  }
  return file;
}

export interface PatchManifest {
  domain: string;
  patches: PatchOp[];
  message?: string;
  dry_run?: boolean;
}

/**
 * Build the JSON manifest sent to POST /api/v1/deploy/patch.
 * Performs client-side validation (defense in depth on top of zod).
 */
export function buildPatchManifest(input: {
  domain: string;
  patches: PatchOp[];
  message?: string;
  dry_run?: boolean;
}): PatchManifest {
  // Domain sanity (zod already enforces, but be explicit)
  if (!input.domain || !/^[a-z0-9.-]+$/i.test(input.domain)) {
    throw new Error(`invalid domain: ${JSON.stringify(input.domain)}`);
  }
  // Re-validate every patch's file path (defense in depth) and catch
  // duplicates that could mask intent.
  const seen = new Set<string>();
  for (const op of input.patches) {
    sanitizeFilePath(op.file);
    if (seen.has(op.file)) {
      throw new Error(
        `duplicate patch target: ${op.file} — combine into a single replace/replace_all op`,
      );
    }
    seen.add(op.file);
  }
  const manifest: PatchManifest = {
    domain: input.domain,
    patches: input.patches,
  };
  if (input.message !== undefined) manifest.message = input.message;
  if (input.dry_run !== undefined) manifest.dry_run = input.dry_run;
  return manifest;
}

// -----------------------------------------------------------------------------
// Worker API call
// -----------------------------------------------------------------------------

export interface PatchApiOpts {
  apiUrl: string;
  manifest: PatchManifest;
  fetcher?: typeof fetch;
  apiKey?: string;
}

export interface PatchApiResponse {
  ok: boolean;
  status: number;
  body: PatchResponse | null;
  raw: string;
}

export async function postPatch(opts: PatchApiOpts): Promise<PatchApiResponse> {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { ok: false, status: 0, body: null, raw: "no fetch implementation available" };
  }
  const url = new URL("/api/v1/deploy/patch", opts.apiUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.manifest),
    });
    const raw = await res.text();
    let body: PatchResponse | null = null;
    try {
      body = JSON.parse(raw) as PatchResponse;
    } catch {
      // server returned non-JSON (HTML error page etc.)
      body = null;
    }
    return { ok: res.ok, status: res.status, body, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------------
// get_current_site — read live file tree for a domain
// -----------------------------------------------------------------------------

export interface CurrentSiteApiOpts {
  apiUrl: string;
  domain: string;
  includeContent?: boolean;
  fetcher?: typeof fetch;
  apiKey?: string;
}

/**
 * Fetch the live site tree + last content hashes for a domain.
 *
 * Pragmatic strategy:
 *   1. Try the convenience endpoint GET /api/v1/deploys/last-good?domain=...
 *      (if the worker exposes it, this is one round-trip).
 *   2. Fall back to the two-step: list deploys for the domain, take the
 *      last good, then GET /api/v1/deploys/:id/files.
 *
 * Returns the parsed CurrentSiteResponse or { ok: false, error }.
 */
export interface CurrentSiteApiResponse {
  ok: boolean;
  status: number;
  body: PatchResponse extends never ? never : import("./schemas.js").CurrentSiteResponse | null;
  raw: string;
}

export async function fetchCurrentSite(
  opts: CurrentSiteApiOpts,
): Promise<{
  ok: boolean;
  status: number;
  body: import("./schemas.js").CurrentSiteResponse | null;
  raw: string;
  source: "last-good" | "list-then-files" | "error";
}> {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.KREXEL_API_KEY ?? "";
  if (typeof doFetch !== "function") {
    return { ok: false, status: 0, body: null, raw: "no fetch implementation available", source: "error" };
  }
  const baseHeaders: Record<string, string> = { accept: "application/json" };
  if (apiKey) baseHeaders.authorization = `Bearer ${apiKey}`;
  const qs = new URLSearchParams({ domain: opts.domain });
  if (opts.includeContent === false) qs.set("include_content", "false");

  // Step 1: try /deploys/last-good (single round-trip if available)
  const lastGoodUrl = new URL(`/api/v1/deploys/last-good?${qs.toString()}`, opts.apiUrl).toString();
  try {
    const r1 = await doFetch(lastGoodUrl, { method: "GET", headers: baseHeaders });
    if (r1.ok) {
      const text = await r1.text();
      try {
        const body = JSON.parse(text) as import("./schemas.js").CurrentSiteResponse;
        return { ok: true, status: r1.status, body, raw: text, source: "last-good" };
      } catch {
        // Server returned 200 but non-JSON; fall through to the 2-step path.
      }
    }
  } catch {
    // Network error on the convenience endpoint: fall through.
  }

  // Step 2: list deploys, take the most recent good one, then GET its files.
  const listUrl = new URL(`/api/v1/deploys?${qs.toString()}`, opts.apiUrl).toString();
  try {
    const r2 = await doFetch(listUrl, { method: "GET", headers: baseHeaders });
    if (!r2.ok) {
      const raw = await r2.text();
      return { ok: false, status: r2.status, body: null, raw, source: "error" };
    }
    const listText = await r2.text();
    const listBody = JSON.parse(listText) as {
      deploys?: Array<{ deploy_id: string; status: string; created_at: string }>;
    };
    const good = (listBody.deploys ?? []).find((d) => d.status === "ready") ?? listBody.deploys?.[0];
    if (!good) {
      return { ok: false, status: 404, body: null, raw: "no deploys found for domain", source: "error" };
    }
    const filesUrl = new URL(
      `/api/v1/deploys/${encodeURIComponent(good.deploy_id)}/files?${qs.toString()}`,
      opts.apiUrl,
    ).toString();
    const r3 = await doFetch(filesUrl, { method: "GET", headers: baseHeaders });
    const raw = await r3.text();
    if (!r3.ok) {
      return { ok: false, status: r3.status, body: null, raw, source: "error" };
    }
    const body = JSON.parse(raw) as import("./schemas.js").CurrentSiteResponse;
    return { ok: true, status: r3.status, body, raw, source: "list-then-files" };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: err instanceof Error ? err.message : String(err),
      source: "error",
    };
  }
}

// -----------------------------------------------------------------------------
// list_file_versions — version history for a single file
// -----------------------------------------------------------------------------

export interface FileVersionsApiOpts {
  apiUrl: string;
  domain: string;
  file: string;
  limit?: number;
  fetcher?: typeof fetch;
  apiKey?: string;
}

export async function fetchFileVersions(opts: FileVersionsApiOpts): Promise<{
  ok: boolean;
  status: number;
  body: import("./schemas.js").FileVersionsResponse | null;
  raw: string;
}> {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.KREXEL_API_KEY ?? "";
  if (typeof doFetch !== "function") {
    return { ok: false, status: 0, body: null, raw: "no fetch implementation available" };
  }
  const qs = new URLSearchParams({
    domain: opts.domain,
    file: opts.file,
    limit: String(opts.limit ?? 10),
  });
  const url = new URL(`/api/v1/file-versions?${qs.toString()}`, opts.apiUrl).toString();
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await doFetch(url, { method: "GET", headers });
    const raw = await res.text();
    let body: import("./schemas.js").FileVersionsResponse | null = null;
    try {
      body = JSON.parse(raw) as import("./schemas.js").FileVersionsResponse;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------------
// get_logs — stream from the worker
// -----------------------------------------------------------------------------

export interface GetLogsApiOpts {
  apiUrl: string;
  deployId: string;
  fetcher?: typeof fetch;
  apiKey?: string;
}

export async function fetchLogs(opts: GetLogsApiOpts): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  raw: string;
}> {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.KREXEL_API_KEY ?? "";
  if (typeof doFetch !== "function") {
    return { ok: false, status: 0, body: null, raw: "no fetch implementation available" };
  }
  const url = new URL(`/api/v1/deploys/${encodeURIComponent(opts.deployId)}/logs`, opts.apiUrl).toString();
  const headers: Record<string, string> = { accept: "text/plain, application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await doFetch(url, { method: "GET", headers });
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // text response — keep as raw string
    }
    return { ok: res.ok, status: res.status, body, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------------
// rollback — real alias switch via the worker
// -----------------------------------------------------------------------------

export interface RollbackApiOpts {
  apiUrl: string;
  domain: string;
  to: string;
  fetcher?: typeof fetch;
  apiKey?: string;
}

export async function postRollback(opts: RollbackApiOpts): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  raw: string;
}> {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.KREXEL_API_KEY ?? "";
  if (typeof doFetch !== "function") {
    return { ok: false, status: 0, body: null, raw: "no fetch implementation available" };
  }
  const url = new URL("/api/v1/deploys/rollback", opts.apiUrl).toString();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ domain: opts.domain, to: opts.to }),
    });
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep raw
    }
    return { ok: res.ok, status: res.status, body, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}