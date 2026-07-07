import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import type { DeployRecord } from "./schemas.js";

/**
 * Local state lives in $KREXEL_HOME (default ~/.krexel) as plain JSON.
 * Phase 1 keeps it simple — no SQLite, no D1.
 *
 *   ~/.krexel/
 *     state.json           # deploy records, account, etc.
 *     env/<domain>.enc     # AES-256-GCM-encrypted env vars
 *     uploads/<deploy_id>/ # zipped folders + manifest.json
 *
 * The MCP server is intentionally single-tenant: one machine, one Krexel
 * account, one master key.
 */

const STATE_FILENAME = "state.json";
const ENV_DIRNAME = "env";
const UPLOADS_DIRNAME = "uploads";

export interface LocalState {
  account: string | null;
  deploys: DeployRecord[];
  // Per-domain last-known-good deploy_id for rollback. Keyed by domain.
  last_good: Record<string, string>;
  // Whatever else we accumulate over time.
  [key: string]: unknown;
}

export const DEFAULT_STATE: LocalState = {
  account: null,
  deploys: [],
  last_good: {},
};

export function krexelHome(): string {
  const fromEnv = process.env.KREXEL_HOME;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".krexel");
}

export function statePath(): string {
  return path.join(krexelHome(), STATE_FILENAME);
}

export function envPathFor(domain: string): string {
  return path.join(krexelHome(), ENV_DIRNAME, `${domain}.enc`);
}

export function uploadDirFor(deployId: string): string {
  return path.join(krexelHome(), UPLOADS_DIRNAME, deployId);
}

export async function ensureHome(): Promise<string> {
  const home = krexelHome();
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(home, ENV_DIRNAME), { recursive: true });
  await fs.mkdir(path.join(home, UPLOADS_DIRNAME), { recursive: true });
  return home;
}

export async function readState(): Promise<LocalState> {
  await ensureHome();
  const p = statePath();
  if (!existsSync(p)) {
    await writeState(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalState>;
    // Tolerate older/partial state files. Spread first, then fill known keys.
    return {
      ...parsed,
      account: parsed.account ?? null,
      deploys: Array.isArray(parsed.deploys) ? parsed.deploys : [],
      last_good:
        parsed.last_good && typeof parsed.last_good === "object"
          ? (parsed.last_good as Record<string, string>)
          : {},
    };
  } catch (err) {
    throw new Error(
      `Could not parse ${p}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix or delete the file and re-run.`,
    );
  }
}

export async function writeState(state: LocalState): Promise<void> {
  await ensureHome();
  const p = statePath();
  // Atomic write: temp file + rename.
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, p);
}

export async function appendDeploy(record: DeployRecord): Promise<LocalState> {
  const state = await readState();
  state.deploys.unshift(record);
  // Keep the log bounded so the file doesn't grow forever.
  state.deploys = state.deploys.slice(0, 500);
  await writeState(state);
  return state;
}

export async function updateDeploy(
  deployId: string,
  patch: Partial<DeployRecord>,
): Promise<DeployRecord | null> {
  const state = await readState();
  const idx = state.deploys.findIndex((d) => d.deploy_id === deployId);
  if (idx === -1) return null;
  const existing = state.deploys[idx];
  if (!existing) return null;
  const updated: DeployRecord = { ...existing, ...patch };
  state.deploys[idx] = updated;
  if (patch.status === "ready") {
    state.last_good[existing.domain] = deployId;
  }
  await writeState(state);
  return updated;
}

export async function findDeploy(deployId: string): Promise<DeployRecord | null> {
  const state = await readState();
  return state.deploys.find((d) => d.deploy_id === deployId) ?? null;
}

export async function listDeploys(
  domain: string | undefined,
  limit: number,
): Promise<DeployRecord[]> {
  const state = await readState();
  let rows = state.deploys;
  if (domain) {
    rows = rows.filter((d) => d.domain === domain);
  }
  return rows.slice(0, limit);
}

// -----------------------------------------------------------------------------
// Env-var encryption (AES-256-GCM with key derived from KREXEL_MASTER_KEY)
// -----------------------------------------------------------------------------

const ENC_ALGO = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12; // 96-bit IV recommended for GCM
const SALT_LEN = 16;

export class MissingMasterKeyError extends Error {
  constructor() {
    super(
      "KREXEL_MASTER_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` " +
        "and put it in your environment (or .env).",
    );
    this.name = "MissingMasterKeyError";
  }
}

export function deriveKey(masterHex: string): Buffer {
  // Accept either 32 raw bytes (64 hex chars) or a passphrase; we always
  // stretch through scrypt so both work.
  const cleaned = masterHex.trim();
  if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    return Buffer.from(cleaned, "hex");
  }
  const salt = Buffer.from("krexel-master-key-v1", "utf8");
  return scryptSync(cleaned, salt, KEY_LEN);
}

export async function encryptEnvValue(
  domain: string,
  key: string,
  value: string,
): Promise<void> {
  const master = process.env.KREXEL_MASTER_KEY;
  if (!master) throw new MissingMasterKeyError();
  await ensureHome();
  const file = envPathFor(domain);
  // Encrypted file layout (JSON for forward-compat):
  //   { v: 1, entries: { KEY: { iv, tag, ct } } }
  let blob: {
    v: number;
    entries: Record<string, { iv: string; tag: string; ct: string }>;
  } = { v: 1, entries: {} };
  if (existsSync(file)) {
    try {
      blob = JSON.parse(await fs.readFile(file, "utf8")) as typeof blob;
    } catch {
      // Treat as empty rather than blowing away secrets — but log a warning.
      blob = { v: 1, entries: {} };
    }
  }
  const dk = deriveKey(master);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ENC_ALGO, dk, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  blob.entries[key] = {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: ct.toString("hex"),
  };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(blob, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function decryptEnvFile(
  domain: string,
): Promise<Record<string, string>> {
  const master = process.env.KREXEL_MASTER_KEY;
  if (!master) throw new MissingMasterKeyError();
  const file = envPathFor(domain);
  if (!existsSync(file)) return {};
  const blob = JSON.parse(await fs.readFile(file, "utf8")) as {
    v: number;
    entries: Record<string, { iv: string; tag: string; ct: string }>;
  };
  const dk = deriveKey(master);
  const out: Record<string, string> = {};
  for (const [k, enc] of Object.entries(blob.entries ?? {})) {
    const decipher = createDecipheriv(
      ENC_ALGO,
      dk,
      Buffer.from(enc.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(enc.tag, "hex"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(enc.ct, "hex")),
      decipher.final(),
    ]);
    out[k] = pt.toString("utf8");
  }
  return out;
}