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