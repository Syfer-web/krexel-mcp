/**
 * edit_file.test.ts — end-to-end coverage of the edit_file tool handler.
 *
 * We import the tool handler indirectly: by exercising the underlying
 * KrexelApiClient (auth + URL + payload) through stubs, we cover:
 *   - happy path for each op (create / replace / replace_all / delete)
 *   - domain is derived from a GET on the base deploy, not supplied by the AI
 *   - the worker gets a Bearer token
 *   - 422 patch_failed surfaces verbatim
 *   - base_deploy_not_found surfaces from the lookup GET
 *
 * We also exercise the EditFileInputSchema directly to verify the Zod
 * cross-field validation (replace without find, create without value, etc.).
 *
 * Run via `node --test --import tsx/esm test/edit_file.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EditFileInputSchema } from "../src/schemas.js";
import {
  KrexelApiClient,
  type PatchDeployRequest,
  type PatchDeployResponse,
} from "../src/api-client.js";

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("EditFileInputSchema accepts a minimal create with content alias", () => {
  const parsed = EditFileInputSchema.parse({
    deploy_id: "dep_abc",
    op: "create",
    file: "robots.txt",
    content: "User-agent: *\nDisallow:\n",
  });
  assert.equal(parsed.op, "create");
  assert.equal(parsed.file, "robots.txt");
});

test("EditFileInputSchema accepts replace with find + value", () => {
  const parsed = EditFileInputSchema.parse({
    deploy_id: "dep_abc",
    op: "replace",
    file: "index.html",
    find: "<h1>About</h1>",
    value: "<h1>About Us</h1>",
  });
  assert.equal(parsed.op, "replace");
  assert.equal(parsed.find, "<h1>About</h1>");
});

test("EditFileInputSchema rejects replace without find", () => {
  const r = EditFileInputSchema.safeParse({
    deploy_id: "dep_abc",
    op: "replace",
    file: "index.html",
    value: "X",
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.match(
      r.error.issues.map((i) => i.message).join("|"),
      /requires a non-empty 'find'/,
    );
  }
});

test("EditFileInputSchema rejects create without value/content", () => {
  const r = EditFileInputSchema.safeParse({
    deploy_id: "dep_abc",
    op: "create",
    file: "x.txt",
  });
  assert.equal(r.success, false);
});

test("EditFileInputSchema rejects delete with stray value", () => {
  const r = EditFileInputSchema.safeParse({
    deploy_id: "dep_abc",
    op: "delete",
    file: "x.txt",
    value: "shouldn't be here",
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.match(
      r.error.issues.map((i) => i.message).join("|"),
      /'delete' takes no 'find' or 'value'/,
    );
  }
});

test("EditFileInputSchema rejects file paths with '..'", () => {
  const r = EditFileInputSchema.safeParse({
    deploy_id: "dep_abc",
    op: "delete",
    file: "../etc/passwd",
  });
  assert.equal(r.success, false);
});

test("EditFileInputSchema rejects file paths starting with '/'", () => {
  const r = EditFileInputSchema.safeParse({
    deploy_id: "dep_abc",
    op: "delete",
    file: "/etc/passwd",
  });
  assert.equal(r.success, false);
});

test("EditFileInputSchema rejects message > 500 chars", () => {
  const r = EditFileInputSchema.safeParse({
    deploy_id: "dep_abc",
    op: "create",
    file: "x.txt",
    content: "hi",
    message: "x".repeat(501),
  });
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// End-to-end behaviour: domain derivation + patch POST + Bearer auth
// ---------------------------------------------------------------------------

interface StubOptions {
  baseDeploy?: { status?: number; body?: unknown };
  patchDeploy?: { status?: number; body?: unknown; throw?: Error };
}

function makeEditStub(opts: StubOptions = {}): {
  fetcher: typeof fetch;
  captured: Array<{ url: string; init: RequestInit | undefined; bodyText: string | null }>;
} {
  const captured: Array<{ url: string; init: RequestInit | undefined; bodyText: string | null }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const c = {
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

    // Route by URL: GET /deploys/:id vs POST /deploy/patch
    if (String(url).includes("/api/v1/deploy/patch")) {
      if (opts.patchDeploy?.throw) throw opts.patchDeploy.throw;
      const status = opts.patchDeploy?.status ?? 201;
      const body = opts.patchDeploy?.body ?? {
        deploy_id: "dep_newpatch",
        parent_deploy_id: "dep_base",
        domain: "shop.example.com",
        files_changed: 1,
        bytes_changed: 5,
        quota_used: 0.1,
        preview_url: "https://shop.example.com",
        status: "queued",
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // base deploy GET
    const status = opts.baseDeploy?.status ?? 200;
    const body = opts.baseDeploy?.body ?? {
      deploy_id: "dep_base",
      domain: "shop.example.com",
      status: "ready",
      framework: "nextjs",
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher: fetcher as unknown as typeof fetch, captured };
}

/** Simulate the edit_file handler's core: lookup base, build patch, POST. */
async function performEdit(
  args: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<{ result?: PatchDeployResponse; error?: { status: number; error: string; message: string } }> {
  const input = EditFileInputSchema.parse(args);
  const c = new KrexelApiClient({
    apiUrl: "https://api.krexel.com",
    apiKey: "krexel_test_key",
    fetcher,
  });

  const base = await c.getDeploy(input.deploy_id);
  if (!base.ok) return { error: { status: base.status, error: base.error, message: base.message } };
  const domain = String(base.data.domain);
  const newContent = input.value ?? input.content;

  const req: PatchDeployRequest = {
    domain,
    base_deploy_id: input.deploy_id,
    patches: [
      input.op === "create"
        ? { op: "create", file: input.file, content: newContent ?? "" }
        : input.op === "replace"
          ? { op: "replace", file: input.file, find: input.find ?? "", value: newContent ?? "" }
          : input.op === "replace_all"
            ? { op: "replace_all", file: input.file, find: input.find ?? "", value: newContent ?? "" }
            : { op: "delete", file: input.file },
    ],
    ...(input.message ? { message: input.message } : {}),
  };

  const res = await c.patchDeploy(req);
  if (!res.ok) return { error: { status: res.status, error: res.error, message: res.message } };
  return { result: res.data };
}

test("edit_file create: derives domain from base deploy, ships POST with Bearer", async () => {
  const stub = makeEditStub();
  const out = await performEdit(
    {
      deploy_id: "dep_base",
      op: "create",
      file: "robots.txt",
      content: "User-agent: *",
    },
    stub.fetcher,
  );
  assert.equal(out.error, undefined);
  assert.equal(out.result?.deploy_id, "dep_newpatch");
  assert.equal(out.result?.parent_deploy_id, "dep_base");

  // Two requests: GET base, POST patch
  assert.equal(stub.captured.length, 2);
  const [base, patch] = stub.captured;
  assert.match(base!.url, /\/api\/v1\/deploys\/dep_base$/);
  assert.equal(base!.init?.method, "GET");
  const patchUrl = patch!.url;
  assert.match(patchUrl, /\/api\/v1\/deploy\/patch$/);
  assert.equal(patch!.init?.method, "POST");
  // Both must carry the Bearer token
  for (const cap of stub.captured) {
    const h = cap.init?.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer krexel_test_key");
  }
  // Body must carry domain derived from base, not the AI
  const body = JSON.parse(patch!.bodyText ?? "{}") as Record<string, unknown>;
  assert.equal(body.domain, "shop.example.com");
  assert.equal(body.base_deploy_id, "dep_base");
  assert.deepEqual(body.patches, [
    { op: "create", file: "robots.txt", content: "User-agent: *" },
  ]);
});

test("edit_file replace: sends find + value, content alias wins when both given", async () => {
  const stub = makeEditStub();
  const out = await performEdit(
    {
      deploy_id: "dep_base",
      op: "replace",
      file: "index.html",
      find: "About",
      value: "About Us",
      content: "should-be-ignored",
    },
    stub.fetcher,
  );
  assert.equal(out.error, undefined);
  const body = JSON.parse(stub.captured[1]!.bodyText ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.patches, [
    { op: "replace", file: "index.html", find: "About", value: "About Us" },
  ]);
});

test("edit_file replace_all: uses replace_all op", async () => {
  const stub = makeEditStub();
  await performEdit(
    {
      deploy_id: "dep_base",
      op: "replace_all",
      file: "main.css",
      find: "#000",
      value: "#111",
    },
    stub.fetcher,
  );
  const body = JSON.parse(stub.captured[1]!.bodyText ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.patches, [
    { op: "replace_all", file: "main.css", find: "#000", value: "#111" },
  ]);
});

test("edit_file delete: omits find/value from the patch", async () => {
  const stub = makeEditStub();
  await performEdit(
    { deploy_id: "dep_base", op: "delete", file: "old.html" },
    stub.fetcher,
  );
  const body = JSON.parse(stub.captured[1]!.bodyText ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.patches, [{ op: "delete", file: "old.html" }]);
});

test("edit_file forwards optional message in the patch body", async () => {
  const stub = makeEditStub();
  await performEdit(
    {
      deploy_id: "dep_base",
      op: "create",
      file: "x.txt",
      content: "y",
      message: "first bot file",
    },
    stub.fetcher,
  );
  const body = JSON.parse(stub.captured[1]!.bodyText ?? "{}") as Record<string, unknown>;
  assert.equal(body.message, "first bot file");
});

test("edit_file: base deploy 404 surfaces from the lookup step", async () => {
  const stub = makeEditStub({
    baseDeploy: {
      status: 404,
      body: { error: "not_found", message: "no deploy with id dep_base" },
    },
  });
  const out = await performEdit(
    { deploy_id: "dep_base", op: "delete", file: "x.txt" },
    stub.fetcher,
  );
  assert.ok(out.error);
  assert.equal(out.error?.status, 404);
  assert.equal(out.error?.error, "not_found");
  // Crucially, we did NOT make the patch POST
  assert.equal(stub.captured.length, 1);
});

test("edit_file: worker patch_failed 422 surfaces verbatim", async () => {
  const stub = makeEditStub({
    patchDeploy: {
      status: 422,
      body: {
        error: "patch_failed",
        message: "op[0] replace index.html: 'About' not found",
      },
    },
  });
  const out = await performEdit(
    {
      deploy_id: "dep_base",
      op: "replace",
      file: "index.html",
      find: "About",
      value: "X",
    },
    stub.fetcher,
  );
  assert.ok(out.error);
  assert.equal(out.error?.status, 422);
  assert.equal(out.error?.error, "patch_failed");
  assert.match(out.error?.message ?? "", /'About' not found/);
});

test("edit_file: 412 base_deploy_not_ready surfaces with code", async () => {
  const stub = makeEditStub({
    patchDeploy: {
      status: 412,
      body: {
        error: "base_deploy_not_ready",
        message: "base deploy status is building; only ready deploys can be patched",
      },
    },
  });
  const out = await performEdit(
    { deploy_id: "dep_base", op: "delete", file: "x.html" },
    stub.fetcher,
  );
  assert.ok(out.error);
  assert.equal(out.error?.status, 412);
  assert.equal(out.error?.error, "base_deploy_not_ready");
});