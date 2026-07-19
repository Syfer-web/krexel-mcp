import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveApiKey, resolveApiUrl } from "../src/auth.js";

const previousHome = process.env.KREXEL_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.KREXEL_HOME;
  else process.env.KREXEL_HOME = previousHome;
});

test("auth resolves the credential saved by krexel login", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "krexel-mcp-auth-"));
  process.env.KREXEL_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({
      api_key: "krx_saved",
      api_url: "https://api.saved.test/",
    }),
  );

  assert.equal(resolveApiKey({ KREXEL_HOME: home }), "krx_saved");
  assert.equal(resolveApiUrl({ KREXEL_HOME: home }), "https://api.saved.test");
});

test("auth environment variables override the saved credential", () => {
  assert.equal(resolveApiKey({ KREXEL_API_KEY: "krx_env" }), "krx_env");
  assert.equal(
    resolveApiUrl({ KREXEL_API_URL: "http://localhost:8787/" }),
    "http://localhost:8787",
  );
});
