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
    .describe("The deploy ID returned from ship_site."),
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

// ---- Conversational edit tools (list_files / read_file / edit_file) -------

const DeployIdField = z
  .string()
  .regex(/^dep_[a-z0-9_]+$/, "deploy_id must start with 'dep_' and contain only [a-z0-9_]");

// Files inside a deploy: relative paths only — letters, digits, '.', '_', '-', '/'.
const FilePathField = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9._/-]+$/, "file path may only contain letters, digits, '.', '_', '-', '/'")
  .refine((p) => !p.includes(".."), "file path may not contain '..'")
  .refine((p) => !p.startsWith("/"), "file path may not start with '/'");

export const ListFilesInputSchema = z.object({
  deploy_id: DeployIdField.describe(
    "The deploy_id to list files for. Must match dep_<base36>_<base36>.",
  ),
});
export type ListFilesInput = z.infer<typeof ListFilesInputSchema>;

export const ReadFileInputSchema = z.object({
  deploy_id: DeployIdField.describe("The deploy_id that contains the file."),
  path: FilePathField.describe(
    "Path to the file inside the deploy, e.g. 'index.html' or 'assets/logo.svg'. No leading slash, no '..'.",
  ),
});
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const EditFileInputSchema = z
  .object({
    deploy_id: DeployIdField.describe(
      "The base deploy_id to patch on top of (the deploy whose file tree you're editing).",
    ),
    op: z
      .enum(["create", "replace", "replace_all", "delete"])
      .describe(
        "Patch operation: 'create' = new file (requires value/content), " +
          "'replace' = first match only (requires find + value), " +
          "'replace_all' = every match (requires find + value), " +
          "'delete' = remove the file.",
      ),
    file: FilePathField.describe("Path of the file to create/replace/delete."),
    find: z
      .string()
      .optional()
      .describe(
        "For replace/replace_all: the exact substring to find inside `file`'s current content.",
      ),
    value: z
      .string()
      .optional()
      .describe("For create/replace/replace_all: the new text."),
    content: z
      .string()
      .optional()
      .describe(
        "Alias for `value`, kept for ergonomics on 'create'. If both `value` and `content` are given, `value` wins.",
      ),
    message: z
      .string()
      .max(500)
      .optional()
      .describe("Optional human-readable note stored alongside the patch deploy."),
  })
  .superRefine((data, ctx) => {
    const needsFind =
      data.op === "replace" || data.op === "replace_all";
    if (needsFind && (data.find === undefined || data.find.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["find"],
        message: `op '${data.op}' requires a non-empty 'find' string`,
      });
    }
    const needsContent =
      data.op === "create" || data.op === "replace" || data.op === "replace_all";
    if (needsContent && data.value === undefined && data.content === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `op '${data.op}' requires 'value' (or 'content')`,
      });
    }
    if (data.op === "delete" && (data.find !== undefined || data.value !== undefined || data.content !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["op"],
        message: "op 'delete' takes no 'find' or 'value' — just 'file'",
      });
    }
  });
export type EditFileInput = z.infer<typeof EditFileInputSchema>;

// ---- Output shapes ----------------------------------------------------------

export interface DeployRecord {
  deploy_id: string;
  domain: string;
  framework: string;
  folder: string;
  status: "queued" | "uploading" | "building" | "ready" | "error";
  preview_url: string;
  created_at: string;
  error?: string;
}

export interface StatusReport {
  account: string | null;
  deploy_count: number;
  platform: string;
  api_url: string;
  state_dir: string;
}