import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolated env for this test file (Node test runner uses a fresh module graph per file).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "afb-ratelimit-test-"));
process.env.DB_PATH = path.join(tmpDir, "feedback.sqlite");
process.env.PUBLIC_PATH = "/f/test-public";
process.env.ADMIN_PATH = "/r/test-admin";
process.env.ADMIN_TOKEN = "test-admin-token-1234567890";
process.env.FEEDBACK_RATE_MAX = "3";
process.env.FEEDBACK_RATE_WINDOW = "1 minute";

const { buildApp } = await import("../src/server.js");
const { closeDatabase } = await import("../src/data.js");

let app;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  try { closeDatabase(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function postFeedback(ip = "203.0.113.10") {
  return app.inject({
    method: "POST",
    url: "/api/feedback",
    payload: { body: "This is a valid piece of feedback." },
    headers: {
      "content-type": "application/json",
      // Simulate Traefik forwarding the real client IP.
      "x-forwarded-for": ip
    }
  });
}

test("per-IP rate limit blocks flooding after the configured max", async () => {
  const ip = "203.0.113.42";

  for (let i = 0; i < 3; i++) {
    const res = await postFeedback(ip);
    assert.equal(res.statusCode, 200, `request #${i + 1} should succeed`);
  }

  const blocked = await postFeedback(ip);
  assert.equal(blocked.statusCode, 429);
  const body = blocked.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Too many requests/i);
});

test("rate limit is per-IP: a different client is not affected", async () => {
  // Prior test exhausted the budget for 203.0.113.42; a different IP still succeeds.
  const res = await postFeedback("198.51.100.7");
  assert.equal(res.statusCode, 200);
});
