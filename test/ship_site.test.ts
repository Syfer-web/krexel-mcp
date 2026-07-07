/**
 * ship_site tests — uses node:test (no external runner) and node:assert.
 * Runs against the unbuilt source via `tsx --esm` (see package.json scripts).
 *
 * What we cover:
 *   1. zips a real folder on disk and writes site.zip + manifest.json
 *   2. returns a deploy_id prefixed with `dep_`
 *   3. throws FolderMissingError on a nonexistent folder
 *   4. when the orchestrator is unreachable, still returns a deploy_id
 *      with api_ok=false and a non-empty api_error — no fake success
 *   5. when the orchestrator returns 200, api_ok=true and api_error=null
 *   6. framework auto-detection picks nextjs/astro/vite/static from package.json
 *   7. AES-256-GCM env encryption round-trips with KREXEL_MASTER_KEY
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import {
  FolderMissingError,
  detectFramework,
  generateDeployId,
  shipSite,
  uploadToApi,
  verifyFolder,
  zipFolder,
} from "../src/ship.js";
import {
  decryptEnvFile,
  deriveKey,
  encryptEnvValue,
  MissingMasterKeyError,
} from "../src/state.js";

function freshDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `krexel-${prefix}-`));
}

function makeSiteFolder(dir: string, withPackageJson?: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>\n");
  writeFileSync(path.join(dir, "style.css"), "body{color:red}\n");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg/>");
  if (withPackageJson) {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(withPackageJson, null, 2));
  }
  return dir;
}

// ---------------------------------------------------------------------------
// generateDeployId
// ---------------------------------------------------------------------------

test("generateDeployId always starts with dep_ and is 20 chars", () => {
  for (let i = 0; i < 50; i++) {
    const id = generateDeployId();
    assert.match(id, /^dep_[A-Za-z0-9]{16}$/, `bad id: ${id}`);
  }
});

// ---------------------------------------------------------------------------
// Folder verification
// ---------------------------------------------------------------------------

test("verifyFolder throws FolderMissingError when path does not exist", () => {
  const missing = path.join(tmpdir(), `nonexistent-${randomBytes(4).toString("hex")}`);
  assert.throws(
    () => verifyFolder(missing),
    FolderMissingError,
  );
});

// ---------------------------------------------------------------------------
// Zip writer
// ---------------------------------------------------------------------------

test("zipFolder produces a non-empty archive with correct EOCD signature", async () => {
  const root = freshDir("zip");
  try {
    const site = makeSiteFolder(path.join(root, "site"));
    const zipPath = path.join(root, "out.zip");
    const bytes = await zipFolder(site, zipPath);
    assert.ok(bytes > 0, "zip should be non-empty");
    assert.ok(existsSync(zipPath));
    // Quick structural check: file ends with EOCD signature 0x06054b50
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(zipPath);
    assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Framework auto-detection
// ---------------------------------------------------------------------------

test("detectFramework picks nextjs / astro / vite / static based on package.json", () => {
  const root = freshDir("framework");
  try {
    const nextDir = makeSiteFolder(path.join(root, "n"), {
      dependencies: { next: "14.0.0" },
    });
    assert.equal(detectFramework(nextDir), "nextjs");

    const astroDir = makeSiteFolder(path.join(root, "a"), {
      dependencies: { astro: "4.0.0" },
    });
    assert.equal(detectFramework(astroDir), "astro");

    const viteDir = makeSiteFolder(path.join(root, "v"), {
      devDependencies: { vite: "5.0.0" },
    });
    assert.equal(detectFramework(viteDir), "vite");

    const plainDir = makeSiteFolder(path.join(root, "s"));
    assert.equal(detectFramework(plainDir), "static");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// uploadToApi — graceful failure when fetch is unreachable / throws
// ---------------------------------------------------------------------------

test("uploadToApi returns ok=false (not throws) when fetch throws", async () => {
  const fakeFetch: typeof fetch = (() => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const res = await uploadToApi({
    apiUrl: "http://localhost:8787",
    deployId: generateDeployId(),
    domain: "x.test",
    framework: "static",
    zipBytes: Buffer.from("not a real zip"),
    zipPath: "/tmp/x.zip",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, false);
  assert.match(res.raw, /ECONNREFUSED/);
  assert.equal(res.status, 0);
});

test("uploadToApi returns ok=false when fetch returns 500", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response("oops", { status: 500 })) as unknown as typeof fetch;
  const res = await uploadToApi({
    apiUrl: "http://localhost:8787",
    deployId: generateDeployId(),
    domain: "x.test",
    framework: "static",
    zipBytes: Buffer.from("x"),
    zipPath: "/tmp/x.zip",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test("uploadToApi parses JSON on 200", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ deploy_id: "dep_abc_xyz", status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const res = await uploadToApi({
    apiUrl: "http://localhost:8787",
    deployId: generateDeployId(),
    domain: "x.test",
    framework: "static",
    zipBytes: Buffer.from("x"),
    zipPath: "/tmp/x.zip",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.body, { deploy_id: "dep_abc_xyz", status: "queued" });
});

// ---------------------------------------------------------------------------
// shipSite end-to-end
// ---------------------------------------------------------------------------

test("shipSite zips folder, writes manifest, returns deploy_id even when API unreachable", async () => {
  const root = freshDir("ship-fail");
  const home = path.join(root, "home");
  process.env.KREXEL_HOME = home;
  try {
    const site = makeSiteFolder(path.join(root, "site"));
    const uploadDir = path.join(home, "uploads", "test");
    const fakeFetch: typeof fetch = (() => {
      throw new Error("ECONNREFUSED 127.0.0.1:8787");
    }) as unknown as typeof fetch;
    const result = await shipSite({
      folder: site,
      domain: "shop.example.com",
      framework: "auto",
      uploadDir,
      fetcher: fakeFetch,
    });

    // deploy_id is ALWAYS present and correctly prefixed
    assert.match(result.deploy_id, /^dep_[A-Za-z0-9]{16}$/);

    // No fake success: api_ok must be false and api_error must surface the upstream failure
    assert.equal(result.api_attempted, true);
    assert.equal(result.api_ok, false);
    assert.ok(result.api_error && result.api_error.length > 0, "api_error must be set");
    assert.match(result.api_error ?? "", /ECONNREFUSED|127\.0\.0\.1:8787/);

    // Local artifacts on disk
    assert.ok(existsSync(result.zip_path), "zip file should exist");
    assert.ok(existsSync(path.join(uploadDir, "manifest.json")), "manifest should exist");
    assert.ok(result.zip_bytes > 0, "zip should have bytes");
    assert.equal(result.framework, "static"); // no package.json
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.KREXEL_HOME;
  }
});

test("shipSite reports api_ok=true when orchestrator returns 200", async () => {
  const root = freshDir("ship-ok");
  const home = path.join(root, "home");
  process.env.KREXEL_HOME = home;
  try {
    const site = makeSiteFolder(path.join(root, "site"));
    const uploadDir = path.join(home, "uploads", "ok");
    const fakeFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ deploy_id: "dep_server_xyz", preview_url: "https://shop.example.com", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await shipSite({
      folder: site,
      domain: "shop.example.com",
      framework: "static",
      uploadDir,
      fetcher: fakeFetch,
    });
    assert.equal(result.api_ok, true);
    assert.equal(result.api_error, null);
    assert.ok(typeof result.api_response === "object" && result.api_response !== null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.KREXEL_HOME;
  }
});

test("shipSite throws on missing folder — does NOT swallow or fake success", async () => {
  await assert.rejects(
    async () => {
      await shipSite({
        folder: "/tmp/does-not-exist-12345",
        domain: "x.test",
        framework: "static",
        uploadDir: "/tmp/krexel-test-uploads",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof FolderMissingError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AES-256-GCM env encryption
// ---------------------------------------------------------------------------

test("encryptEnvValue round-trips through decryptEnvFile with KREXEL_MASTER_KEY", async () => {
  const root = freshDir("env-enc");
  process.env.KREXEL_HOME = root;
  const master = randomBytes(32).toString("hex");
  process.env.KREXEL_MASTER_KEY = master;
  try {
    await encryptEnvValue("shop.example.com", "API_TOKEN", "sk_test_12345");
    await encryptEnvValue("shop.example.com", "OTHER", "hello");
    const out = await decryptEnvFile("shop.example.com");
    assert.equal(out["API_TOKEN"], "sk_test_12345");
    assert.equal(out["OTHER"], "hello");
    // File is on disk
    assert.ok(existsSync(path.join(root, "env", "shop.example.com.enc")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.KREXEL_HOME;
    delete process.env.KREXEL_MASTER_KEY;
  }
});

test("encryptEnvValue throws MissingMasterKeyError when KREXEL_MASTER_KEY is unset", async () => {
  const root = freshDir("env-nokey");
  process.env.KREXEL_HOME = root;
  delete process.env.KREXEL_MASTER_KEY;
  try {
    await assert.rejects(
      async () => encryptEnvValue("x.test", "K", "V"),
      MissingMasterKeyError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.KREXEL_HOME;
  }
});

test("deriveKey accepts 32-byte hex", () => {
  const k = deriveKey(randomBytes(32).toString("hex"));
  assert.equal(k.length, 32);
});

test("deriveKey stretches a passphrase via scrypt", () => {
  const k = deriveKey("hunter2");
  assert.equal(k.length, 32);
  const k2 = deriveKey("hunter2");
  assert.ok(k.equals(k2));
  const k3 = deriveKey("hunter3");
  assert.ok(!k.equals(k3));
});