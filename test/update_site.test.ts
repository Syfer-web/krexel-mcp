/**
 * Tests for the conversational edit-and-deploy feature (v0.2.0):
 *
 *   - PatchOp validation (good + bad inputs via zod)
 *   - update_site manifest construction (path safety, dedup, quota)
 *   - get_current_site response parsing (last-good + list-then-files)
 *   - list_file_versions diff generation
 *   - update_site quota is always 0.1
 *   - get_logs and rollback pass-through
 *
 * Run with the same script as ship_site.test.ts:
 *   node --test --import tsx/esm test/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FILE_PATH_RE,
  GetCurrentSiteInputSchema,
  ListFileVersionsInputSchema,
  PatchCreateSchema,
  PatchDeleteSchema,
  PatchOpSchema,
  PatchReplaceAllSchema,
  PatchReplaceSchema,
  UpdateSiteInputSchema,
} from "../src/schemas.js";
import {
  buildPatchManifest,
  fetchCurrentSite,
  fetchFileVersions,
  fetchLogs,
  PATCH_QUOTA_COST,
  postPatch,
  postRollback,
  sanitizeFilePath,
} from "../src/update.js";
import {
  buildFileVersionsResponse,
  buildHistoryWithDiffs,
  unifiedDiff,
} from "../src/version.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("PATCH_QUOTA_COST is exactly 0.1 (spec constant)", () => {
  assert.equal(PATCH_QUOTA_COST, 0.1);
});

test("FILE_PATH_RE matches the spec literal /^[a-zA-Z0-9._/-]+$/", () => {
  // Spec-mandated regex. Permits dots, underscores, slashes, and dashes.
  // Defense-in-depth path checks (sanitizeFilePath) reject traversal and
  // absolute paths; this regex just constrains the character class.
  assert.equal(FILE_PATH_RE.test("index.html"), true);
  assert.equal(FILE_PATH_RE.test("assets/logo.svg"), true);
  assert.equal(FILE_PATH_RE.test("a/b/c/d.txt"), true);
  assert.equal(FILE_PATH_RE.test("../etc/passwd"), true); // caught downstream
  assert.equal(FILE_PATH_RE.test("/etc/passwd"), true); // caught downstream
  assert.equal(FILE_PATH_RE.test("a b.html"), false);
  assert.equal(FILE_PATH_RE.test("foo;rm.html"), false);
  assert.equal(FILE_PATH_RE.test("a\nb"), false);
  assert.equal(FILE_PATH_RE.test(""), false);
});

// ---------------------------------------------------------------------------
// sanitizeFilePath — defense in depth
// ---------------------------------------------------------------------------

test("sanitizeFilePath accepts clean paths", () => {
  assert.equal(sanitizeFilePath("index.html"), "index.html");
  assert.equal(sanitizeFilePath("assets/logo.svg"), "assets/logo.svg");
  assert.equal(sanitizeFilePath("deep/nested/path.txt"), "deep/nested/path.txt");
});

test("sanitizeFilePath rejects path traversal", () => {
  assert.throws(() => sanitizeFilePath("../etc/passwd"), /\.\./);
  assert.throws(() => sanitizeFilePath("a/../b"), /\.\./);
  assert.throws(() => sanitizeFilePath("a/b/.."), /\.\./);
});

test("sanitizeFilePath rejects absolute paths and whitespace", () => {
  assert.throws(() => sanitizeFilePath("/etc/passwd"), /start with/);
  assert.throws(() => sanitizeFilePath("  index.html"), /whitespace/);
  assert.throws(() => sanitizeFilePath("index.html  "), /whitespace/);
});

test("sanitizeFilePath rejects empty / non-string", () => {
  assert.throws(() => sanitizeFilePath(""), /non-empty/);
  // @ts-expect-error — runtime check, not type check
  assert.throws(() => sanitizeFilePath(null), /non-empty/);
});

// ---------------------------------------------------------------------------
// PatchOp zod validation — good + bad
// ---------------------------------------------------------------------------

test("PatchOpSchema accepts every supported op type", () => {
  const ok = [
    { op: "create", file: "new.html", content: "<h1>x</h1>" },
    { op: "replace", file: "about.html", find: "<h1>About</h1>", value: "<h1>About Us</h1>" },
    { op: "replace_all", file: "style.css", find: "red", value: "blue" },
    { op: "delete", file: "old.html" },
  ];
  for (const p of ok) {
    const parsed = PatchOpSchema.parse(p);
    assert.equal(parsed.op, p.op);
  }
});

test("PatchCreateSchema rejects whitespace and special chars in file", () => {
  // The spec regex permits slashes and dots — sanitizeFilePath catches
  // '..' and absolute paths downstream. Here we only test what zod catches.
  assert.throws(() =>
    PatchCreateSchema.parse({ op: "create", file: "a b.html", content: "y" }),
  );
  assert.throws(() =>
    PatchCreateSchema.parse({ op: "create", file: "foo;rm.html", content: "y" }),
  );
  assert.throws(() =>
    PatchCreateSchema.parse({ op: "create", file: "x\ty", content: "y" }),
  );
});

test("PatchReplaceSchema rejects missing find/value", () => {
  assert.throws(() =>
    PatchReplaceSchema.parse({ op: "replace", file: "x.html", find: "" }),
  );
  assert.throws(() =>
    PatchReplaceSchema.parse({ op: "replace", file: "x.html" }),
  );
});

test("PatchReplaceAllSchema accepts the same shape as replace", () => {
  const p = PatchReplaceAllSchema.parse({
    op: "replace_all",
    file: "style.css",
    find: "red",
    value: "blue",
  });
  assert.equal(p.op, "replace_all");
});

test("PatchDeleteSchema requires only op + file", () => {
  const p = PatchDeleteSchema.parse({ op: "delete", file: "old.html" });
  assert.equal(p.op, "delete");
  assert.equal(p.file, "old.html");
});

test("PatchOpSchema rejects unknown op", () => {
  assert.throws(() =>
    PatchOpSchema.parse({ op: "rename", file: "x.html" }),
  );
});

// ---------------------------------------------------------------------------
// UpdateSiteInputSchema — top-level validation
// ---------------------------------------------------------------------------

test("UpdateSiteInputSchema requires domain and patches", () => {
  assert.throws(() => UpdateSiteInputSchema.parse({}), /Required/);
  assert.throws(() => UpdateSiteInputSchema.parse({ domain: "x.test" }), /Required/);
});

test("UpdateSiteInputSchema rejects empty patch list", () => {
  assert.throws(() =>
    UpdateSiteInputSchema.parse({ domain: "x.test", patches: [] }),
  );
});

test("UpdateSiteInputSchema caps patches at 50", () => {
  const many = Array.from({ length: 51 }, (_, i) => ({
    op: "replace" as const,
    file: `f${i}.html`,
    find: "a",
    value: "b",
  }));
  assert.throws(() =>
    UpdateSiteInputSchema.parse({ domain: "x.test", patches: many }),
  );
});

test("GetCurrentSiteInputSchema defaults include_content to true", () => {
  const parsed = GetCurrentSiteInputSchema.parse({ domain: "x.test" });
  assert.equal(parsed.include_content, true);
});

test("ListFileVersionsInputSchema defaults limit to 10", () => {
  const parsed = ListFileVersionsInputSchema.parse({
    domain: "x.test",
    file: "about.html",
  });
  assert.equal(parsed.limit, 10);
});

// ---------------------------------------------------------------------------
// buildPatchManifest — quota + dedup + path safety
// ---------------------------------------------------------------------------

test("buildPatchManifest builds a clean manifest with all 4 op types", () => {
  const manifest = buildPatchManifest({
    domain: "shop.example.com",
    patches: [
      { op: "create", file: "new.html", content: "<h1>x</h1>" },
      { op: "replace", file: "about.html", find: "About", value: "About Us" },
      { op: "replace_all", file: "style.css", find: "red", value: "blue" },
      { op: "delete", file: "old.html" },
    ],
    message: "test",
  });
  assert.equal(manifest.domain, "shop.example.com");
  assert.equal(manifest.patches.length, 4);
  assert.equal(manifest.message, "test");
});

test("buildPatchManifest rejects duplicate patch targets", () => {
  assert.throws(
    () =>
      buildPatchManifest({
        domain: "x.test",
        patches: [
          { op: "replace", file: "a.html", find: "x", value: "y" },
          { op: "delete", file: "a.html" },
        ],
      }),
    /duplicate patch target/,
  );
});

test("buildPatchManifest rejects traversal even though zod regex allows ..", () => {
  // zod regex actually rejects '..' because it doesn't match /^[a-zA-Z0-9._/-]+$/
  // (it does — both '.' are in the char class). So sanitizeFilePath is the
  // second line of defense.
  assert.throws(
    () =>
      buildPatchManifest({
        domain: "x.test",
        patches: [{ op: "delete", file: "../etc/passwd" }],
      }),
    /\.\./,
  );
});

test("buildPatchManifest includes dry_run when set", () => {
  const m = buildPatchManifest({
    domain: "x.test",
    patches: [{ op: "delete", file: "a.html" }],
    dry_run: true,
  });
  assert.equal(m.dry_run, true);
});

// ---------------------------------------------------------------------------
// postPatch — quota is always 0.1 (server-enforced)
// ---------------------------------------------------------------------------

test("postPatch sends POST to /api/v1/deploy/patch with JSON body", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody = "";
  let capturedContentType = "";
  const fakeFetch: typeof fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedMethod = String(init?.method);
    capturedBody = String(init?.body);
    const h = (init?.headers ?? {}) as Record<string, string>;
    capturedContentType = h["content-type"] ?? h["Content-Type"] ?? "";
    return new Response(
      JSON.stringify({
        deploy_id: "dep_xyz",
        parent_deploy_id: "dep_abc",
        domain: "shop.example.com",
        files_changed: 1,
        bytes_changed: 5,
        quota_used: 0.1,
        preview_url: "https://shop.example.com",
        status: "queued",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const res = await postPatch({
    apiUrl: "http://localhost:8787",
    manifest: {
      domain: "shop.example.com",
      patches: [{ op: "replace", file: "index.html", find: "x", value: "y" }],
    },
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  assert.match(capturedUrl, /\/api\/v1\/deploy\/patch$/);
  assert.equal(capturedMethod, "POST");
  assert.equal(capturedContentType, "application/json");
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.domain, "shop.example.com");
  assert.equal(parsed.patches[0].op, "replace");
});

test("postPatch response carries quota_used=0.1 (server constant)", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        deploy_id: "dep_xyz",
        parent_deploy_id: "dep_abc",
        domain: "x.test",
        files_changed: 1,
        bytes_changed: 1,
        quota_used: 0.1,
        preview_url: "https://x.test",
        status: "queued",
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const res = await postPatch({
    apiUrl: "http://localhost:8787",
    manifest: {
      domain: "x.test",
      patches: [{ op: "delete", file: "a.html" }],
    },
    fetcher: fakeFetch,
  });
  assert.equal(res.body?.quota_used, 0.1);
});

test("postPatch returns ok=false (not throws) when fetch throws", async () => {
  const fakeFetch: typeof fetch = (() => {
    throw new Error("ECONNREFUSED 127.0.0.1:8787");
  }) as unknown as typeof fetch;
  const res = await postPatch({
    apiUrl: "http://localhost:8787",
    manifest: {
      domain: "x.test",
      patches: [{ op: "delete", file: "a.html" }],
    },
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.match(res.raw, /ECONNREFUSED/);
});

test("postPatch sends Authorization header when apiKey is provided", async () => {
  let capturedAuth = "";
  const fakeFetch: typeof fetch = (async (_url, init) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    capturedAuth = h.authorization ?? h.Authorization ?? "";
    return new Response(JSON.stringify({ deploy_id: "dep_x", quota_used: 0.1 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  await postPatch({
    apiUrl: "http://localhost:8787",
    manifest: { domain: "x.test", patches: [{ op: "delete", file: "a.html" }] },
    apiKey: "krx_live_abcdef",
    fetcher: fakeFetch,
  });
  assert.equal(capturedAuth, "Bearer krx_live_abcdef");
});

// ---------------------------------------------------------------------------
// fetchCurrentSite — single round-trip + fallback to list-then-files
// ---------------------------------------------------------------------------

test("fetchCurrentSite hits /last-good first when available", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        domain: "x.test",
        deploy_id: "dep_lg",
        created_at: "2026-07-08T00:00:00Z",
        files: [{ path: "index.html", size: 12, sha256: "abc", content: "<h1>x</h1>" }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const res = await fetchCurrentSite({
    apiUrl: "http://localhost:8787",
    domain: "x.test",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, "last-good");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/api\/v1\/deploys\/last-good\?domain=x\.test/);
});

test("fetchCurrentSite falls back to list-then-files when /last-good 404s", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response("not found", { status: 404 });
    }
    if (calls.length === 2) {
      return new Response(
        JSON.stringify({
          deploys: [
            { deploy_id: "dep_good", status: "ready", created_at: "2026-07-08T00:00:00Z" },
            { deploy_id: "dep_old", status: "error", created_at: "2026-07-07T00:00:00Z" },
          ],
        }),
        { status: 200 },
      );
    }
    // 3rd call: files for dep_good
    return new Response(
      JSON.stringify({
        domain: "x.test",
        deploy_id: "dep_good",
        created_at: "2026-07-08T00:00:00Z",
        files: [{ path: "index.html", size: 12, sha256: "abc", content: "<h1>x</h1>" }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const res = await fetchCurrentSite({
    apiUrl: "http://localhost:8787",
    domain: "x.test",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, "list-then-files");
  assert.equal(res.body?.deploy_id, "dep_good");
  assert.equal(calls.length, 3);
  assert.match(calls[2]!, /\/api\/v1\/deploys\/dep_good\/files/);
});

// ---------------------------------------------------------------------------
// fetchFileVersions + diff generation
// ---------------------------------------------------------------------------

test("fetchFileVersions parses worker JSON response", async () => {
  const fakeFetch: typeof fetch = (async (url) => {
    assert.match(String(url), /\/api\/v1\/file-versions/);
    return new Response(
      JSON.stringify({
        domain: "x.test",
        file: "about.html",
        history: [
          { deploy_id: "dep_2", parent_deploy_id: "dep_1", created_at: "2026-07-08" },
          { deploy_id: "dep_1", parent_deploy_id: null, created_at: "2026-07-07" },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const res = await fetchFileVersions({
    apiUrl: "http://localhost:8787",
    domain: "x.test",
    file: "about.html",
    limit: 5,
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  assert.equal(res.body?.history.length, 2);
  assert.equal(res.body?.history[0]?.deploy_id, "dep_2");
});

test("unifiedDiff returns undefined for identical contents", () => {
  const d = unifiedDiff({
    file: "x.html",
    oldContent: "<h1>x</h1>",
    newContent: "<h1>x</h1>",
  });
  assert.equal(d, undefined);
});

test("unifiedDiff produces a unified-diff patch for changed contents", () => {
  const d = unifiedDiff({
    file: "about.html",
    oldContent: "<h1>About</h1>\n",
    newContent: "<h1>About Us</h1>\n",
  });
  assert.ok(d !== undefined);
  assert.match(d!, /Index: about\.html/);
  assert.match(d!, /About/);
  assert.match(d!, /About Us/);
});

test("buildHistoryWithDiffs annotates entries with diffs vs previous version", () => {
  const out = buildHistoryWithDiffs(
    [
      {
        deploy_id: "dep_2",
        parent_deploy_id: "dep_1",
        created_at: "2026-07-08",
        content: "<h1>About Us</h1>\n",
      },
      {
        deploy_id: "dep_1",
        parent_deploy_id: null,
        created_at: "2026-07-07",
        content: "<h1>About</h1>\n",
      },
    ],
    "about.html",
  );
  assert.equal(out.length, 2);
  assert.ok(out[0]!.diff !== undefined);
  assert.match(out[0]!.diff!, /About Us/);
  // Oldest entry has no previous → no diff
  assert.equal(out[1]!.diff, undefined);
});

test("buildFileVersionsResponse wraps history in the typed envelope", () => {
  const res = buildFileVersionsResponse({
    domain: "x.test",
    file: "about.html",
    versions: [
      { deploy_id: "dep_1", parent_deploy_id: null, created_at: "2026-07-07", content: "a" },
    ],
  });
  assert.equal(res.domain, "x.test");
  assert.equal(res.file, "about.html");
  assert.equal(res.history.length, 1);
});

// ---------------------------------------------------------------------------
// fetchLogs + postRollback — pass-through behavior
// ---------------------------------------------------------------------------

test("fetchLogs returns ok=true with body when orchestrator streams logs", async () => {
  const fakeFetch: typeof fetch = (async (url) => {
    assert.match(String(url), /\/api\/v1\/deploys\/dep_x\/logs/);
    return new Response("[deploy] Ready\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as unknown as typeof fetch;
  const res = await fetchLogs({
    apiUrl: "http://localhost:8787",
    deployId: "dep_x",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  assert.equal(typeof res.body, "string");
});

test("fetchLogs returns ok=false when orchestrator 500s (no fake success)", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response("oops", { status: 500 })) as unknown as typeof fetch;
  const res = await fetchLogs({
    apiUrl: "http://localhost:8787",
    deployId: "dep_x",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test("postRollback POSTs to /api/v1/deploys/rollback and returns worker response", async () => {
  let capturedBody = "";
  const fakeFetch: typeof fetch = (async (_url, init) => {
    capturedBody = String(init?.body);
    return new Response(
      JSON.stringify({
        domain: "x.test",
        from_deploy_id: "dep_2",
        to_deploy_id: "dep_1",
        status: "rolled_back",
        estimated_propagation_seconds: 8,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const res = await postRollback({
    apiUrl: "http://localhost:8787",
    domain: "x.test",
    to: "dep_1",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, true);
  const sent = JSON.parse(capturedBody);
  assert.equal(sent.domain, "x.test");
  assert.equal(sent.to, "dep_1");
  const body = res.body as { estimated_propagation_seconds: number };
  assert.equal(body.estimated_propagation_seconds, 8);
});

test("postRollback returns ok=false when worker rejects (no fake success)", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response("quota exceeded", { status: 429 })) as unknown as typeof fetch;
  const res = await postRollback({
    apiUrl: "http://localhost:8787",
    domain: "x.test",
    to: "dep_1",
    fetcher: fakeFetch,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
});