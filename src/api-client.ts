/**
 * api-client.ts — typed Krexel Worker API client for the MCP server.
 *
 * Centralizes every HTTP call the MCP server makes to api.krexel.com (or the
 * dev URL set via KREXEL_API_URL) and FORWARDS the user's API key on every
 * request. Before this module existed, ship_site posted a multipart upload
 * with no Authorization header — the worker rejected it with 401.
 *
 * Every method returns a discriminated union: { ok: true, ...data } on
 * success, { ok: false, error, message, http_status } on any failure.
 * Callers always know the wire status code and can surface a useful message.
 *
 * The `fetcher` injection seam is for tests — pass a stub to assert
 * headers/URLs/body without ever opening a socket.
 */

export interface KrexelApiClientOpts {
  apiUrl: string;
  /** Bearer token to send on every request. If empty, calls still go out but the worker will 401. */
  apiKey: string;
  /** Inject for tests so we never hit the network. */
  fetcher?: typeof fetch;
}

export interface ApiOk<T> {
  ok: true;
  status: number;
  data: T;
}
export interface ApiErr {
  ok: false;
  status: number;
  error: string;
  message: string;
  /** Raw response body — JSON if parseable, otherwise raw text. */
  body: unknown;
}
export type ApiResult<T> = ApiOk<T> | ApiErr;

// ---------------------------------------------------------------------------
// Typed wire shapes (mirror worker/src/schemas.ts + index.ts responses)
// ---------------------------------------------------------------------------

export interface MeResponse {
  email: string;
  plan: string;
  created_at: string;
  cloudflare_connected: boolean;
  cloudflare_account_id?: string;
}

export interface DeploySummary {
  deploy_id: string;
  domain: string;
  parent_deploy_id?: string | null;
  is_patch?: boolean;
  status: string;
  framework?: string;
  created_at?: string;
  preview_url?: string;
  [key: string]: unknown;
}

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
  content?: string;
}

export interface FilesResponse {
  deploy_id: string;
  domain: string;
  created_at?: string;
  parent_deploy_id?: string | null;
  is_patch?: boolean;
  files: FileEntry[];
}

export interface PatchOpCreate {
  op: "create";
  file: string;
  content: string;
}
export interface PatchOpReplace {
  op: "replace";
  file: string;
  find: string;
  value: string;
}
export interface PatchOpReplaceAll {
  op: "replace_all";
  file: string;
  find: string;
  value: string;
}
export interface PatchOpDelete {
  op: "delete";
  file: string;
}
export type PatchOpWire =
  | PatchOpCreate
  | PatchOpReplace
  | PatchOpReplaceAll
  | PatchOpDelete;

export interface PatchDeployRequest {
  domain: string;
  base_deploy_id: string;
  patches: PatchOpWire[];
  message?: string;
}

export interface PatchDeployResponse {
  deploy_id: string;
  parent_deploy_id: string;
  domain: string;
  files_changed: number;
  bytes_changed: number;
  quota_used: number;
  preview_url?: string;
  status: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class KrexelApiClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(opts: KrexelApiClientOpts) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetcher = opts.fetcher ?? globalThis.fetch;
  }

  // ---- public methods -----------------------------------------------------

  /** GET /api/v1/me — current customer (email, plan, CF status). */
  async getMe(): Promise<ApiResult<MeResponse>> {
    return this.request<MeResponse>("GET", "/api/v1/me");
  }

  /** GET /api/v1/deploys/:id — single deploy record (gives us `domain`). */
  async getDeploy(deployId: string): Promise<ApiResult<DeploySummary>> {
    if (!isDeployId(deployId)) {
      return this.err(400, "invalid_id", "deploy id must match dep_<base36>_<base36>");
    }
    return this.request<DeploySummary>("GET", `/api/v1/deploys/${encodeURIComponent(deployId)}`);
  }

  /**
   * GET /api/v1/deploys/:id/files?include_content=false — manifest only.
   * The default `include_content=true` mode inlines every file's bytes,
   * which is enormous for a listing-only call.
   */
  async listFiles(deployId: string): Promise<ApiResult<FilesResponse>> {
    if (!isDeployId(deployId)) {
      return this.err(400, "invalid_id", "deploy id must match dep_<base36>_<base36>");
    }
    return this.request<FilesResponse>(
      "GET",
      `/api/v1/deploys/${encodeURIComponent(deployId)}/files?include_content=false`,
    );
  }

  /**
   * Read a single file from a deploy. Fetches the manifest-with-content and
   * filters to the requested path. We don't add a per-file worker endpoint
   * because the manifest endpoint already exists and works — duplicating
   * the route for one tool would just drift over time.
   */
  async readFile(
    deployId: string,
    path: string,
  ): Promise<ApiResult<{ deploy_id: string; path: string; content: string; sha256: string; size: number; domain: string }>> {
    if (!isDeployId(deployId)) {
      return this.err(400, "invalid_id", "deploy id must match dep_<base36>_<base36>");
    }
    const pathErr = validateFilePath(path);
    if (pathErr) return this.err(400, "invalid_path", pathErr);

    const tree = await this.request<FilesResponse>(
      "GET",
      `/api/v1/deploys/${encodeURIComponent(deployId)}/files?include_content=true`,
    );
    if (!tree.ok) return tree;

    const entry = tree.data.files.find((f) => f.path === path);
    if (!entry) {
      return this.err(
        404,
        "file_not_found",
        `file '${path}' not found in deploy ${deployId} (deploy has ${tree.data.files.length} files)`,
      );
    }
    if (entry.content === undefined) {
      // Worker returns a manifest entry without content when R2 lost the bytes.
      return this.err(
        410,
        "file_content_unavailable",
        `file '${path}' is in the manifest but its bytes were pruned from R2`,
      );
    }
    return {
      ok: true,
      status: 200,
      data: {
        deploy_id: tree.data.deploy_id,
        path: entry.path,
        content: entry.content,
        sha256: entry.sha256,
        size: entry.size,
        domain: tree.data.domain,
      },
    };
  }

  /**
   * POST /api/v1/deploy/patch — apply a list of ops on top of base_deploy_id.
   * Returns the new patch deploy record (deploy_id, preview_url, byte counts).
   */
  async patchDeploy(
    req: PatchDeployRequest,
  ): Promise<ApiResult<PatchDeployResponse>> {
    if (!isDeployId(req.base_deploy_id)) {
      return this.err(400, "invalid_id", "base_deploy_id must match dep_<base36>_<base36>");
    }
    if (!req.domain || typeof req.domain !== "string") {
      return this.err(400, "invalid_domain", "domain is required");
    }
    if (!Array.isArray(req.patches) || req.patches.length === 0) {
      return this.err(400, "invalid_patches", "patches must be a non-empty array");
    }
    if (req.message !== undefined && (typeof req.message !== "string" || req.message.length > 500)) {
      return this.err(400, "invalid_message", "message must be a string of <= 500 chars");
    }
    return this.request<PatchDeployResponse>("POST", "/api/v1/deploy/patch", req);
  }

  // ---- internals ----------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    jsonBody?: unknown,
  ): Promise<ApiResult<T>> {
    if (typeof this.fetcher !== "function") {
      return this.err(0, "no_fetch", "no fetch implementation available");
    }
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      // Bug #1 fix: always forward the user's API key as a Bearer token.
      // The worker requires this on every authed endpoint.
      Authorization: this.apiKey ? `Bearer ${this.apiKey}` : "",
      Accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(jsonBody);
    }
    let res: Response;
    try {
      res = await this.fetcher(url, { method, headers, body });
    } catch (err) {
      return this.err(0, "network_error", err instanceof Error ? err.message : String(err));
    }
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      const obj = (parsed && typeof parsed === "object" ? parsed : {}) as {
        error?: string;
        message?: string;
      };
      return this.err(
        res.status,
        obj.error ?? `http_${res.status}`,
        (obj.message ?? raw) || `request failed with status ${res.status}`,
        parsed,
      );
    }
    return { ok: true, status: res.status, data: parsed as T };
  }

  private err(status: number, code: string, message: string, body: unknown = null): ApiErr {
    return { ok: false, status, error: code, message, body };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests + handlers)
// ---------------------------------------------------------------------------

const DEPLOY_ID_RE = /^dep_[a-z0-9_]+$/i;

export function isDeployId(s: string): boolean {
  return typeof s === "string" && DEPLOY_ID_RE.test(s);
}

const FILE_PATH_RE = /^[a-zA-Z0-9._/-]+$/;

export function validateFilePath(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return "file path is required";
  if (p.includes("..")) return "file path may not contain '..'";
  if (p.startsWith("/")) return "file path may not start with '/'";
  if (!FILE_PATH_RE.test(p)) {
    return "file path may only contain letters, digits, '.', '_', '-', '/'";
  }
  return null;
}

/** Factory matching how the worker reads its env, exposed for handlers/tests. */
export function defaultKrexelApiClient(): KrexelApiClient {
  return new KrexelApiClient({
    apiUrl: process.env.KREXEL_API_URL ?? "http://localhost:8787",
    apiKey: process.env.KREXEL_API_KEY ?? "",
  });
}