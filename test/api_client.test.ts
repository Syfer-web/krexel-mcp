/**
 * api_client.test.ts — auth forwarding + happy/error paths for KrexelApiClient.
 *
 * All tests inject a `fetcher` stub so we never open a socket. The stubs
 * record the URL, method, headers, and body they received, and return a
 * canned Response. That lets us assert "Authorization: Bearer <key>" was
 * sent on EVERY endpoint — which is the contract that was broken in
 * ship.ts before this module existed.
 *
 * Run via `node --test --import tsx/esm test/api_client.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KrexelApiClient,
  isDeployId,
  validateFilePath,
} from "../src/api-client.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  init: RequestInit | undefined;
  bodyText: string | null;
}

function makeStub(
  handler: (captured: Captured) => Response | Promise<Response>,
): { fetcher: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const c: Captured = {
      url: String(url),
      init,
      bodyText:
        init?.body && typeof init.body === "string"
          ? init.body
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : null,
    };
    captured.push(c);
    return await handler(c);
  };
  return { fetcher: fetcher as unknown as typeof fetch, captured };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KEY = "krexel_test_abc123def456";

function clientWith(stub: ReturnType<typeof makeStub>): KrexelApiClient {
  return new KrexelApiClient({
    apiUrl: "https://api.krexel.com",
    apiKey: KEY,
    fetcher: stub.fetcher,
  });
}

// ---------------------------------------------------------------------------
// isDeployId / validateFilePath (pure helpers)
// ---------------------------------------------------------------------------

test("isDeployId accepts the documented format", () => {
  assert.equal(isDeployId("dep_abc_123"), true);
  assert.equal(isDeployId("dep_ABC"), true); // case-insensitive on the worker side too
  assert.equal(isDeployId("dep_"), false); // empty base
  assert.equal(isDeployId("dep"), false); // missing underscore
  assert.equal(isDeployId("foo_abc"), false);
  assert.equal(isDeployId(""), false);
});

test("validateFilePath rejects traversal and absolute paths", () => {
  assert.equal(validateFilePath("index.html"), null);
  assert.equal(validateFilePath("assets/logo.svg"), null);
  assert.equal(validateFilePath("a/b/c.js"), null);
  // bad
  assert.ok(validateFilePath("../etc/passwd")?.includes(".."));
  assert.ok(validateFilePath("/etc/passwd")?.includes("/"));
  assert.ok(validateFilePath("foo bar.html")?.includes("only contain"));
  assert.ok(validateFilePath("")?.includes("required"));
});

// ---------------------------------------------------------------------------
// AUTH FORWARDING — the bug this module was created to fix.
// ---------------------------------------------------------------------------

test("getMe forwards `Authorization: Bearer <key>` on every request", async () => {
  const stub = makeStub(() =>
    jsonResponse(200, {
      email: "user@test.com",
      plan: "builder",
      cloudflare_connected: true,
      created_at: "2026-01-01T00:00:00Z",
    }),
  );
  const c = clientWith(stub);
  const res = await c.getMe();
  assert.equal(res.ok, true);
  assert.equal(stub.captured.length, 1);
  const cap = stub.captured[0]!;
  assert.equal(cap.url, "https://api.krexel.com/api/v1/me");
  assert.equal(cap.init?.method, "GET");
  const headers = cap.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
});

test("listFiles forwards the Bearer token + uses include_content=false", async () => {
  const stub = makeStub(() =>
    jsonResponse(200, {
      deploy_id: "dep_abc",
      domain: "shop.example.com",
      files: [{ path: "index.html", size: 42, sha256: "deadbeef" }],
    }),
  );
  const c = clientWith(stub);
  const res = await c.listFiles("dep_abc");
  assert.equal(res.ok, true);
  const cap = stub.captured[0]!;
  assert.equal(cap.url, "https://api.krexel.com/api/v1/deploys/dep_abc/files?include_content=false");
  const headers = cap.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers.Accept, "application/json");
});

test("readFile forwards Bearer + filters manifest to the requested path", async () => {
  const stub = makeStub(() =>
    jsonResponse(200, {
      deploy_id: "dep_abc",
      domain: "shop.example.com",
      files: [
        { path: "index.html", size: 12, sha256: "aaa", content: "<h1>hi</h1>" },
        { path: "style.css", size: 7, sha256: "bbb", content: "body{}" },
      ],
    }),
  );
  const c = clientWith(stub);
  const res = await c.readFile("dep_abc", "index.html");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.path, "index.html");
    assert.equal(res.data.content, "<h1>hi</h1>");
    assert.equal(res.data.sha256, "aaa");
    assert.equal(res.data.domain, "shop.example.com");
  }
  const cap = stub.captured[0]!;
  assert.equal(cap.url, "https://api.krexel.com/api/v1/deploys/dep_abc/files?include_content=true");
  const headers = cap.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
});

test("readFile returns file_not_found (404) when path is missing from the manifest", async () => {
  const stub = makeStub(() =>
    jsonResponse(200, {
      deploy_id: "dep_abc",
      domain: "x.test",
      files: [{ path: "index.html", size: 1, sha256: "aa", content: "x" }],
    }),
  );
  const c = clientWith(stub);
  const res = await c.readFile("dep_abc", "missing.html");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 404);
    assert.equal(res.error, "file_not_found");
  }
});

test("readFile returns file_content_unavailable (410) when manifest lacks content", async () => {
  const stub = makeStub(() =>
    jsonResponse(200, {
      deploy_id: "dep_abc",
      domain: "x.test",
      files: [{ path: "img.png", size: 100, sha256: "aa" }], // no content field
    }),
  );
  const c = clientWith(stub);
  const res = await c.readFile("dep_abc", "img.png");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 410);
    assert.equal(res.error, "file_content_unavailable");
  }
});

test("patchDeploy sends POST with JSON body + Bearer token", async () => {
  const stub = makeStub(() =>
    jsonResponse(201, {
      deploy_id: "dep_newpatch",
      parent_deploy_id: "dep_base",
      domain: "shop.example.com",
      files_changed: 1,
      bytes_changed: 42,
      quota_used: 0.1,
      preview_url: "https://shop.example.com",
      status: "queued",
    }),
  );
  const c = clientWith(stub);
  const res = await c.patchDeploy({
    domain: "shop.example.com",
    base_deploy_id: "dep_base",
    patches: [{ op: "replace", file: "index.html", find: "About", value: "About Us" }],
    message: "change heading",
  });
  assert.equal(res.ok, true);
  const cap = stub.captured[0]!;
  assert.equal(cap.init?.method, "POST");
  assert.equal(cap.url, "https://api.krexel.com/api/v1/deploy/patch");
  const headers = cap.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(cap.bodyText ?? "{}") as Record<string, unknown>;
  assert.equal(body.domain, "shop.example.com");
  assert.equal(body.base_deploy_id, "dep_base");
  assert.equal(body.message, "change heading");
  assert.deepEqual(body.patches, [
    { op: "replace", file: "index.html", find: "About", value: "About Us" },
  ]);
});

test("getDeploy forwards Bearer token", async () => {
  const stub = makeStub(() =>
    jsonResponse(200, {
      deploy_id: "dep_abc",
      domain: "shop.example.com",
      status: "ready",
      framework: "nextjs",
    }),
  );
  const c = clientWith(stub);
  const res = await c.getDeploy("dep_abc");
  assert.equal(res.ok, true);
  const cap = stub.captured[0]!;
  assert.equal(cap.url, "https://api.krexel.com/api/v1/deploys/dep_abc");
  const headers = cap.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test("401 from worker surfaces error code + message from the body", async () => {
  const stub = makeStub(() =>
    jsonResponse(401, {
      error: "missing_or_invalid_authorization",
      message: "Missing or invalid Authorization header",
    }),
  );
  const c = clientWith(stub);
  const res = await c.getMe();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.error, "missing_or_invalid_authorization");
    assert.match(res.message, /Missing or invalid/);
  }
});

test("422 patch_failed surfaces the worker's error message verbatim", async () => {
  const stub = makeStub(() =>
    jsonResponse(422, {
      error: "patch_failed",
      message: "op[0] replace index.html: 'About' not found",
    }),
  );
  const c = clientWith(stub);
  const res = await c.patchDeploy({
    domain: "x.test",
    base_deploy_id: "dep_base",
    patches: [{ op: "replace", file: "index.html", find: "About", value: "X" }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 422);
    assert.equal(res.error, "patch_failed");
    assert.match(res.message, /'About' not found/);
  }
});

test("network failure returns status=0 and a network_error code", async () => {
  const stub = makeStub(() => {
    throw new Error("ECONNREFUSED 127.0.0.1:8787");
  });
  const c = clientWith(stub);
  const res = await c.getMe();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 0);
    assert.equal(res.error, "network_error");
    assert.match(res.message, /ECONNREFUSED/);
  }
});

test("non-JSON error body falls back to status-based error code", async () => {
  const stub = makeStub(() => new Response("Bad Gateway", { status: 502 }));
  const c = clientWith(stub);
  const res = await c.getMe();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 502);
    assert.equal(res.error, "http_502");
    assert.match(res.message, /Bad Gateway/);
  }
});

test("empty API key sends no Authorization header (worker will 401)", async () => {
  const stub = makeStub(() =>
    jsonResponse(401, { error: "unauthorized", message: "no key" }),
  );
  const c = new KrexelApiClient({
    apiUrl: "https://api.krexel.com",
    apiKey: "",
    fetcher: stub.fetcher,
  });
  await c.getMe();
  const headers = stub.captured[0]!.init?.headers as Record<string, string>;
  // The header is set to an empty string — fetcher libraries strip it.
  // Either empty string or absent is acceptable; the worker will reject.
  assert.ok(
    headers.Authorization === "" || headers.Authorization === undefined,
    `expected empty Authorization, got ${JSON.stringify(headers.Authorization)}`,
  );
});

// ---------------------------------------------------------------------------
// Input validation (client-side guards, before hitting the network)
// ---------------------------------------------------------------------------

test("listFiles rejects malformed deploy_id without making a request", async () => {
  const stub = makeStub(() => jsonResponse(200, { files: [] }));
  const c = clientWith(stub);
  const res = await c.listFiles("not-a-deploy-id");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 400);
    assert.equal(res.error, "invalid_id");
  }
  assert.equal(stub.captured.length, 0, "should not have hit the network");
});

test("readFile rejects traversal path without making a request", async () => {
  const stub = makeStub(() => jsonResponse(200, { files: [] }));
  const c = clientWith(stub);
  const res = await c.readFile("dep_abc", "../secrets.txt");
  assert.equal(res.ok, false);
  assert.equal(stub.captured.length, 0);
});

test("patchDeploy rejects empty patches array without making a request", async () => {
  const stub = makeStub(() => jsonResponse(201, {}));
  const c = clientWith(stub);
  const res = await c.patchDeploy({
    domain: "x.test",
    base_deploy_id: "dep_abc",
    patches: [],
  });
  assert.equal(res.ok, false);
  assert.equal(stub.captured.length, 0);
});

// ---------------------------------------------------------------------------
// API URL normalization
// ---------------------------------------------------------------------------

test("trailing slash on apiUrl is stripped (no double //)", async () => {
  const stub = makeStub(() => jsonResponse(200, { email: "x", plan: "free" }));
  const c = new KrexelApiClient({
    apiUrl: "https://api.krexel.com///",
    apiKey: KEY,
    fetcher: stub.fetcher,
  });
  await c.getMe();
  assert.equal(stub.captured[0]!.url, "https://api.krexel.com/api/v1/me");
});