import { z } from "zod";

/**
 * Zod schemas for Krexel MCP tool inputs/outputs.
 *
 * Keep these as the single source of truth — both the tool handlers and the
 * generated tool/list descriptions read from here so the LLM sees the same
 * shape the server validates.
 */

export const FrameworkSchema = z
  .enum(["auto", "nextjs", "astro", "vite", "static"])
  .default("auto")
  .describe(
    "Build framework hint. 'auto' detects from package.json / index.html; the others pin a specific framework for Cloudflare Pages.",
  );

// ---- Patch manifest (used by update_site) ---------------------------------

/**
 * Filesystem-safe path regex: alphanumerics, dot, underscore, hyphen, slash.
 * No leading slash. The `..` segment check is enforced separately for
 * defense-in-depth (see sanitizeFilePath in update.ts).
 */
export const FILE_PATH_RE = /^[a-zA-Z0-9._/-]+$/;
export const FILE_PATH_DESC =
  "Filesystem-safe path within the site, e.g. 'index.html' or 'assets/logo.svg'.";

export const PatchCreateSchema = z.object({
  op: z.literal("create"),
  file: z.string().regex(FILE_PATH_RE, "file must match /^[a-zA-Z0-9._/-]+$/"),
  content: z.string().describe("Full file content to write."),
});
export const PatchReplaceSchema = z.object({
  op: z.literal("replace"),
  file: z.string().regex(FILE_PATH_RE, "file must match /^[a-zA-Z0-9._/-]+$/"),
  find: z.string().min(1).describe("Exact substring to replace (first occurrence)."),
  value: z.string().describe("Replacement text."),
});
export const PatchReplaceAllSchema = z.object({
  op: z.literal("replace_all"),
  file: z.string().regex(FILE_PATH_RE, "file must match /^[a-zA-Z0-9._/-]+$/"),
  find: z.string().min(1).describe("Exact substring to replace (every occurrence)."),
  value: z.string().describe("Replacement text."),
});
export const PatchDeleteSchema = z.object({
  op: z.literal("delete"),
  file: z.string().regex(FILE_PATH_RE, "file must match /^[a-zA-Z0-9._/-]+$/"),
});

export const PatchOpSchema = z.discriminatedUnion("op", [
  PatchCreateSchema,
  PatchReplaceSchema,
  PatchReplaceAllSchema,
  PatchDeleteSchema,
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

// ---- Tool inputs ----------------------------------------------------------

export const ShipSiteInputSchema = z.object({
  folder: z
    .string()
    .min(1)
    .describe(
      "Absolute or ~-relative path to the built site directory. Must exist and be readable.",
    ),
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9.-]+$/i, "domain must be a valid hostname (a-z, 0-9, ., -)")
    .describe("The custom domain to attach, e.g. 'shop.example.com'."),
  framework: FrameworkSchema,
});
export type ShipSiteInput = z.infer<typeof ShipSiteInputSchema>;

export const GetCurrentSiteInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9.-]+$/i, "domain must be a valid hostname")
    .describe("Domain to inspect (e.g. 'shop.example.com')."),
  include_content: z
    .boolean()
    .default(true)
    .describe(
      "Whether to include file contents in the response. Set false to fetch only the file tree + hashes (saves bandwidth).",
    ),
});
export type GetCurrentSiteInput = z.infer<typeof GetCurrentSiteInputSchema>;

export const UpdateSiteInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9.-]+$/i, "domain must be a valid hostname")
    .describe("Domain whose deployed site you want to edit."),
  patches: z
    .array(PatchOpSchema)
    .min(1)
    .max(50, "max 50 patches per request")
    .describe(
      "Patch operations applied in order to the live site (max 50). Each becomes part of a versioned deploy.",
    ),
  message: z
    .string()
    .max(500)
    .optional()
    .describe("Optional human-readable note stored in the audit log."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, validate patches and return what would change without deploying."),
});
export type UpdateSiteInput = z.infer<typeof UpdateSiteInputSchema>;

export const ListFileVersionsInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9.-]+$/i, "domain must be a valid hostname")
    .describe("Domain to inspect."),
  file: z
    .string()
    .regex(FILE_PATH_RE, "file must match /^[a-zA-Z0-9._/-]+$/")
    .describe("Path within the site, e.g. 'about.html'."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(10)
    .describe("Maximum number of versions to return (default 10)."),
});
export type ListFileVersionsInput = z.infer<typeof ListFileVersionsInputSchema>;

export const ListDeploysInputSchema = z.object({
  domain: z
    .string()
    .optional()
    .describe("If provided, only return deploys for this domain."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum number of deploys to return (default 20, max 100)."),
});
export type ListDeploysInput = z.infer<typeof ListDeploysInputSchema>;

export const GetLogsInputSchema = z.object({
  deploy_id: z
    .string()
    .regex(/^dep_[a-z0-9_]+$/, "deploy_id must start with 'dep_'")
    .describe("The deploy ID returned from ship_site or update_site."),
});
export type GetLogsInput = z.infer<typeof GetLogsInputSchema>;

export const RollbackInputSchema = z.object({
  domain: z.string().min(1),
  to: z
    .string()
    .regex(/^dep_[a-z0-9_]+$/)
    .describe("The deploy_id to roll back to."),
});
export type RollbackInput = z.infer<typeof RollbackInputSchema>;

export const SetEnvInputSchema = z.object({
  domain: z.string().min(1),
  key: z
    .string()
    .min(1)
    .regex(/^[A-Z0-9_]+$/i, "env var keys should be uppercase letters/digits/underscores"),
  value: z.string(),
});
export type SetEnvInput = z.infer<typeof SetEnvInputSchema>;

export const GetStatusInputSchema = z.object({});
export type GetStatusInput = z.infer<typeof GetStatusInputSchema>;

// ---- Output shapes ----------------------------------------------------------

export interface DeployRecord {
  deploy_id: string;
  domain: string;
  framework: string;
  folder: string;
  status: "queued" | "uploading" | "building" | "ready" | "error";
  preview_url: string;
  created_at: string;
  parent_deploy_id?: string | null;
  message?: string;
  error?: string;
}

export interface StatusReport {
  account: string | null;
  deploy_count: number;
  platform: string;
  api_url: string;
  state_dir: string;
}

export interface CurrentSiteFile {
  path: string;
  size: number;
  sha256: string;
  content?: string;
}

export interface CurrentSiteResponse {
  domain: string;
  deploy_id: string;
  created_at: string;
  files: CurrentSiteFile[];
}

export interface PatchResponse {
  deploy_id: string;
  parent_deploy_id: string | null;
  domain: string;
  files_changed: number;
  bytes_changed: number;
  quota_used: number;
  preview_url: string;
  status: "queued" | "building" | "ready" | "error";
  message?: string;
}

export interface FileVersionEntry {
  deploy_id: string;
  parent_deploy_id: string | null;
  created_at: string;
  message?: string;
  diff?: string;
}

export interface FileVersionsResponse {
  domain: string;
  file: string;
  history: FileVersionEntry[];
}