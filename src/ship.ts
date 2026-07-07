import { promises as fs, existsSync, statSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createWriteStream } from "node:fs";
import { customAlphabet } from "nanoid";
import { FormData } from "undici";

/**
 * ship_site core: zip a folder, write manifest, attempt to upload to the
 * Krexel Worker. The deploy_id is ALWAYS returned, even when the orchestrator
 * API is unreachable — the response carries an `api_ok` flag and `api_error`
 * string so callers can distinguish real success from a local-only stage.
 *
 * Determinism note: every deploy_id begins with `dep_` and uses a URL-safe
 * alphabet so it's safe to use as an R2 key prefix without escaping.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const newId = customAlphabet(ALPHABET, 16);

export function generateDeployId(): string {
  return `dep_${newId()}`;
}

export function detectFramework(folder: string): "nextjs" | "astro" | "vite" | "static" {
  const pkg = path.join(folder, "package.json");
  if (existsSync(pkg)) {
    try {
      const json = JSON.parse(readFileSync(pkg, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...json.dependencies, ...json.devDependencies };
      if (all.next) return "nextjs";
      if (all.astro) return "astro";
      if (all.vite) return "vite";
    } catch {
      // fall through to static
    }
  }
  return "static";
}

export interface ShipResult {
  deploy_id: string;
  preview_url: string;
  framework: string;
  upload_dir: string;
  zip_path: string;
  zip_bytes: number;
  api_attempted: boolean;
  api_ok: boolean | null;
  api_error: string | null;
  api_response: unknown | null;
}

export class FolderMissingError extends Error {
  constructor(public folder: string) {
    super(`Folder does not exist or is not readable: ${folder}`);
    this.name = "FolderMissingError";
  }
}

export class FolderNotDirectoryError extends Error {
  constructor(public folder: string) {
    super(`Path exists but is not a directory: ${folder}`);
    this.name = "FolderNotDirectoryError";
  }
}

export function verifyFolder(folder: string): string {
  const resolved = path.resolve(folder);
  if (!existsSync(resolved)) throw new FolderMissingError(resolved);
  const st = statSync(resolved);
  if (!st.isDirectory()) throw new FolderNotDirectoryError(resolved);
  return resolved;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  localHeaderOffset: number;
}

/**
 * Minimal store-only zip writer. We avoid pulling in a runtime dep just to
 * bundle a folder — STORE-only zips are short to write and our deploy
 * payloads are already minified.
 *
 * Limitations: STORE only, no zip64, no encryption, one entry per file.
 * Fine for Phase 1 (deploy payloads are <500MB typical).
 */
export async function zipFolder(folder: string, outPath: string): Promise<number> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Pass 1: gather all files and compute per-entry local-header offsets.
  const entries: ZipEntry[] = [];
  let cursor = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        await walk(abs, rel);
      } else if (d.isFile()) {
        const data = await fs.readFile(abs);
        const nameBuf = Buffer.from(rel, "utf8");
        entries.push({
          name: rel,
          data,
          crc: crc32(data),
          localHeaderOffset: cursor,
        });
        cursor += 30 + nameBuf.length + data.length;
      }
      // symlinks and others: skipped in Phase 1
    }
  }

  await walk(folder, "");

  const out = createWriteStream(outPath);
  // Local file headers + file data
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // gp flags
    header.writeUInt16LE(0, 8); // method = store
    header.writeUInt16LE(0, 10); // mtime
    header.writeUInt16LE(0, 12); // mdate
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.data.length, 18); // compressed
    header.writeUInt32LE(entry.data.length, 22); // uncompressed
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra len
    await writeAll(out, [header, nameBuf, entry.data]);
  }

  // Central directory
  const cdParts: Buffer[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(entry.crc, 16);
    cd.writeUInt32LE(entry.data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk #
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(entry.localHeaderOffset, 42);
    cdParts.push(cd, nameBuf);
  }
  let cdSize = 0;
  for (const p of cdParts) cdSize += p.length;
  await writeAll(out, cdParts);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with cd start
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cursor, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  await writeAll(out, [eocd]);

  await new Promise<void>((resolve) => out.end(resolve));

  const st = statSync(outPath);
  return st.size;
}

async function writeAll(stream: ReturnType<typeof createWriteStream>, parts: Buffer[]): Promise<void> {
  for (const part of parts) {
    if (stream.write(part)) continue;
    await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
  }
}

// Standard CRC-32 (poly 0xEDB88320), used in zip file headers.
const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === undefined) continue;
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// -----------------------------------------------------------------------------
// Multipart upload to the Krexel orchestrator
// -----------------------------------------------------------------------------

export interface ApiUploadOpts {
  apiUrl: string;
  deployId: string;
  domain: string;
  framework: string;
  zipBytes: Buffer;
  zipPath: string;
  // Injectable for tests so we don't actually open a socket.
  fetcher?: typeof fetch;
}

export interface ApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
  raw: string;
}

export async function uploadToApi(opts: ApiUploadOpts): Promise<ApiResponse> {
  const doFetch = opts.fetcher ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: "no fetch implementation available",
    };
  }
  const url = new URL("/api/v1/deploy", opts.apiUrl).toString();
  const form = new FormData();
  form.append("deploy_id", new Blob([opts.deployId]));
  form.append("domain", new Blob([opts.domain]));
  form.append("framework", new Blob([opts.framework]));
  form.append(
    "manifest",
    new Blob([
      JSON.stringify(
        {
          deploy_id: opts.deployId,
          domain: opts.domain,
          framework: opts.framework,
          zip_filename: path.basename(opts.zipPath),
          zip_bytes: opts.zipBytes.length,
          created_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    ]),
    "manifest.json",
  );
  form.append("file", new Blob([new Uint8Array(opts.zipBytes)]), path.basename(opts.zipPath));
  try {
    const res = await doFetch(url, {
      method: "POST",
      body: form as unknown as RequestInit["body"],
    });
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // non-JSON response: keep raw text
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
// High-level ship_site orchestrator
// -----------------------------------------------------------------------------

export interface ShipSiteArgs {
  folder: string;
  domain: string;
  framework: "auto" | "nextjs" | "astro" | "vite" | "static";
  uploadDir: string;
  fetcher?: typeof fetch;
}

export async function shipSite(args: ShipSiteArgs): Promise<ShipResult> {
  const resolvedFolder = verifyFolder(args.folder);
  const framework =
    args.framework === "auto" ? detectFramework(resolvedFolder) : args.framework;
  const deployId = generateDeployId();
  const uploadDir = args.uploadDir;
  await fs.mkdir(uploadDir, { recursive: true });

  const zipPath = path.join(uploadDir, "site.zip");
  const zipBytes = await zipFolder(resolvedFolder, zipPath);

  const manifest = {
    deploy_id: deployId,
    domain: args.domain,
    framework,
    source_folder: resolvedFolder,
    zip_filename: "site.zip",
    zip_bytes: zipBytes,
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(uploadDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  const apiUrl = process.env.KREXEL_API_URL ?? "http://localhost:8787";
  const zipBuffer = await fs.readFile(zipPath);
  const apiRes = await uploadToApi({
    apiUrl,
    deployId,
    domain: args.domain,
    framework,
    zipBytes: zipBuffer,
    zipPath,
    ...(args.fetcher ? { fetcher: args.fetcher } : {}),
  });

  return {
    deploy_id: deployId,
    preview_url: `https://${args.domain}`,
    framework,
    upload_dir: uploadDir,
    zip_path: zipPath,
    zip_bytes: zipBytes,
    api_attempted: true,
    api_ok: apiRes.ok,
    api_error: apiRes.ok ? null : `Orchestrator returned ${apiRes.status}: ${apiRes.raw}`,
    api_response: apiRes.body,
  };
}